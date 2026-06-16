# Speedtest GH

一个基于 Go 的单容器测速页面，支持：

- 浏览器到本站的延迟测试：每秒 1 次，共 20 次
- 下载速度测试
- 上传速度测试

## 本地运行

```bash
go run .
```

默认监听 `http://localhost:8080`。

## Docker 本地启动

```bash
docker compose up --build
```

启动后访问 `http://localhost:8080`。

## GitHub CI 与镜像

仓库包含 GitHub Actions 工作流：

- 文件：`.github/workflows/docker-image.yml`
- 触发：推送到 `main`、推送 `v*` tag、发起到 `main` 的 PR、手动触发
- 镜像仓库：`ghcr.io/<owner>/<repo>`

当代码推送到 `main` 时，会自动构建并发布：

- `ghcr.io/<owner>/<repo>:main`
- `ghcr.io/<owner>/<repo>:latest`
- `ghcr.io/<owner>/<repo>:sha-<commit>`

推送 `v1.0.0` 这类 tag 时，还会额外发布同名版本 tag 镜像。

## 服务配置

支持以下环境变量：

- `PORT`：服务监听端口，默认 `8080`
- `DOWNLOAD_DURATION_SECONDS`：下载测速目标时长，默认 `8`
- `UPLOAD_DURATION_SECONDS`：上传测速目标时长，默认 `8`
- `MAX_UPLOAD_SIZE_MB`：上传大小限制，默认 `200`

## 反向代理说明

生产环境建议由现有 Nginx 或 Caddy 反向代理到容器 `8080` 端口。

代理层需要注意：

- 不要缓存 `/api/ping`
- 不要压缩或缓存 `/api/download`
- 尽量关闭对测速接口的代理缓冲，避免影响结果

Nginx 示例：

```nginx
server {
    listen 80;
    server_name your-domain.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ping {
        proxy_pass http://127.0.0.1:8080;
        proxy_buffering off;
        proxy_cache off;
        add_header Cache-Control no-store;
    }

    location /api/download {
        proxy_pass http://127.0.0.1:8080;
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        add_header Cache-Control no-store;
    }
}
```

## 健康检查

```bash
curl -i http://localhost:8080/healthz
```

返回 `200 OK` 即表示容器存活。
