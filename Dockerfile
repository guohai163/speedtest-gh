FROM golang:1.24.5-alpine AS builder

WORKDIR /app

COPY go.mod ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /speedtest-server .

FROM alpine:3.22

WORKDIR /app

COPY --from=builder /speedtest-server /app/speedtest-server
COPY --from=builder /app/web /app/web

EXPOSE 8080

CMD ["/app/speedtest-server"]
