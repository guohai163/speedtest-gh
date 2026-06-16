package main

import (
	"encoding/json"
	"html/template"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlePing(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	rec := httptest.NewRecorder()

	handlePing(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected Cache-Control no-store, got %q", got)
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to parse JSON: %v", err)
	}
	if ok, _ := payload["ok"].(bool); !ok {
		t.Fatalf("expected ok=true, got %#v", payload["ok"])
	}
}

func TestHandleIndexRendersConfig(t *testing.T) {
	tmpl := template.Must(template.New("index").Parse(`<!doctype html><script>window.SPEEDTEST_CONFIG = {{ .Config }};</script>`))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	handleIndex(config{
		DownloadDurationSeconds: 9,
		UploadDurationSeconds:   7,
	}, tmpl)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"downloadDurationSeconds":9`) {
		t.Fatalf("expected download duration config in body, got %s", body)
	}
	if !strings.Contains(body, `"uploadDurationSeconds":7`) {
		t.Fatalf("expected upload duration config in body, got %s", body)
	}
}

func TestHandleUploadSuccess(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/upload", strings.NewReader(strings.Repeat("a", 1024)))
	rec := httptest.NewRecorder()

	handleUpload(config{MaxUploadSizeMB: 1})(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var payload speedResult
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to parse JSON: %v", err)
	}
	if payload.ReceivedBytes != 1024 {
		t.Fatalf("expected 1024 bytes, got %d", payload.ReceivedBytes)
	}
}

func TestHandleUploadLimit(t *testing.T) {
	body := strings.NewReader(strings.Repeat("b", 2*1024*1024))
	req := httptest.NewRequest(http.MethodPost, "/api/upload", body)
	rec := httptest.NewRecorder()

	handleUpload(config{MaxUploadSizeMB: 1})(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected status 413, got %d", rec.Code)
	}
}

func TestHandleDownloadHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/download", nil)
	rec := httptest.NewRecorder()

	handleDownload(config{DownloadDurationSeconds: 1})(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("expected application/octet-stream, got %q", got)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "identity" {
		t.Fatalf("expected Content-Encoding identity, got %q", got)
	}
	if rec.Body.Len() == 0 {
		t.Fatalf("expected non-empty body")
	}
}
