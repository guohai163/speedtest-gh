package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"io/fs"
	"log"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

const (
	defaultPort             = "8080"
	defaultDownloadSeconds  = 8
	defaultUploadSeconds    = 8
	defaultMaxUploadSizeMB  = 200
	downloadChunkSize       = 64 * 1024
	uploadReadBufferSize    = 64 * 1024
	serverShutdownTimeout   = 10 * time.Second
	staticCacheControlValue = "no-store"
)

type config struct {
	Port                    string
	DownloadDurationSeconds int
	UploadDurationSeconds   int
	MaxUploadSizeMB         int64
}

type pageConfig struct {
	DownloadDurationSeconds int    `json:"downloadDurationSeconds"`
	UploadDurationSeconds   int    `json:"uploadDurationSeconds"`
	ClientIP                string `json:"clientIp"`
	UserAgent               string `json:"userAgent"`
}

type pageData struct {
	Config template.JS
}

type jsonResponse map[string]any

type speedResult struct {
	ReceivedBytes int64   `json:"receivedBytes"`
	DurationMs    float64 `json:"durationMs"`
	Mbps          float64 `json:"mbps"`
	TargetSeconds int     `json:"targetSeconds"`
}

func main() {
	cfg := loadConfig()
	staticFS, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("failed to prepare static fs: %v", err)
	}
	indexTemplate, err := template.ParseFS(webFS, "web/index.html")
	if err != nil {
		log.Fatalf("failed to parse index template: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", handleIndex(cfg, indexTemplate))
	mux.Handle("/styles.css", cacheControlMiddleware(http.FileServer(http.FS(staticFS))))
	mux.Handle("/app.js", cacheControlMiddleware(http.FileServer(http.FS(staticFS))))
	mux.HandleFunc("/favicon.ico", handleFavicon)
	mux.HandleFunc("/api/ping", handlePing)
	mux.HandleFunc("/api/download", handleDownload(cfg))
	mux.HandleFunc("/api/upload", handleUpload(cfg))
	mux.HandleFunc("/healthz", handleHealth)

	handler := loggingMiddleware(mux)
	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), serverShutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown error: %v", err)
		}
	}()

	log.Printf("speedtest server listening on :%s", cfg.Port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server failed: %v", err)
	}
}

func loadConfig() config {
	return config{
		Port:                    getEnv("PORT", defaultPort),
		DownloadDurationSeconds: getEnvInt("DOWNLOAD_DURATION_SECONDS", defaultDownloadSeconds),
		UploadDurationSeconds:   getEnvInt("UPLOAD_DURATION_SECONDS", defaultUploadSeconds),
		MaxUploadSizeMB:         int64(getEnvInt("MAX_UPLOAD_SIZE_MB", defaultMaxUploadSizeMB)),
	}
}

func handlePing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	setNoStoreHeaders(w)
	writeJSON(w, http.StatusOK, jsonResponse{
		"ok":        true,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func handleIndex(cfg config, tmpl *template.Template) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}

		payload, err := json.Marshal(pageConfig{
			DownloadDurationSeconds: cfg.DownloadDurationSeconds,
			UploadDurationSeconds:   cfg.UploadDurationSeconds,
			ClientIP:                resolveClientIP(r),
			UserAgent:               r.UserAgent(),
		})
		if err != nil {
			log.Printf("failed to encode page config: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to render page")
			return
		}

		data := pageData{Config: template.JS(payload)}
		setNoStoreHeaders(w)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := tmpl.Execute(w, data); err != nil {
			log.Printf("failed to render index: %v", err)
		}
	}
}

func handleFavicon(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

func handleDownload(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}

		setNoStoreHeaders(w)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Encoding", "identity")
		w.Header().Set("X-Content-Type-Options", "nosniff")

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeError(w, http.StatusInternalServerError, "streaming not supported")
			return
		}

		duration := time.Duration(cfg.DownloadDurationSeconds) * time.Second
		deadline := time.Now().Add(duration)
		buf := make([]byte, downloadChunkSize)
		src := rand.New(rand.NewSource(time.Now().UnixNano()))

		for time.Now().Before(deadline) {
			if _, err := src.Read(buf); err != nil {
				return
			}
			if _, err := w.Write(buf); err != nil {
				return
			}
			flusher.Flush()

			select {
			case <-r.Context().Done():
				return
			default:
			}
		}
	}
}

func handleUpload(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}

		setNoStoreHeaders(w)

		maxBytes := cfg.MaxUploadSizeMB * 1024 * 1024
		r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		defer r.Body.Close()

		start := time.Now()
		buffer := make([]byte, uploadReadBufferSize)
		var received int64

		for {
			n, err := r.Body.Read(buffer)
			received += int64(n)
			if err == nil {
				continue
			}
			if errors.Is(err, io.EOF) {
				break
			}
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				writeError(w, http.StatusRequestEntityTooLarge, "upload exceeded size limit")
				return
			}
			writeError(w, http.StatusBadRequest, "failed to read upload stream")
			return
		}

		elapsed := time.Since(start)
		mbps := calculateMbps(received, elapsed)

		writeJSON(w, http.StatusOK, speedResult{
			ReceivedBytes: received,
			DurationMs:    float64(elapsed.Milliseconds()),
			Mbps:          mbps,
			TargetSeconds: cfg.UploadDurationSeconds,
		})
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, jsonResponse{
		"ok":    false,
		"error": message,
	})
}

func setNoStoreHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", staticCacheControlValue)
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
}

func calculateMbps(bytes int64, elapsed time.Duration) float64 {
	seconds := elapsed.Seconds()
	if seconds <= 0 {
		return 0
	}
	return (float64(bytes) * 8 / 1_000_000) / seconds
}

func getEnv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func getEnvInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func resolveClientIP(r *http.Request) string {
	forwardedFor := r.Header.Get("X-Forwarded-For")
	if forwardedFor != "" {
		parts := strings.Split(forwardedFor, ",")
		if len(parts) > 0 {
			candidate := strings.TrimSpace(parts[0])
			if candidate != "" {
				return candidate
			}
		}
	}

	realIP := strings.TrimSpace(r.Header.Get("X-Real-IP"))
	if realIP != "" {
		return realIP
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

func cacheControlMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setNoStoreHeaders(w)
		next.ServeHTTP(w, r)
	})
}

func loggingMiddleware(next http.Handler) http.Handler {
	var mu sync.Mutex
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		mu.Lock()
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		mu.Unlock()
	})
}
