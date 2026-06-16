const startButton = document.getElementById("startButton");
const retryButton = document.getElementById("retryButton");
const statusText = document.getElementById("statusText");
const phaseBadge = document.getElementById("phaseBadge");
const latencySummary = document.getElementById("latencySummary");
const downloadHeadline = document.getElementById("downloadHeadline");
const uploadHeadline = document.getElementById("uploadHeadline");
const avgLatency = document.getElementById("avgLatency");
const minLatency = document.getElementById("minLatency");
const maxLatency = document.getElementById("maxLatency");
const jitterLatency = document.getElementById("jitterLatency");
const latencyMeta = document.getElementById("latencyMeta");
const latencyCount = document.getElementById("latencyCount");
const latencyChart = document.getElementById("latencyChart");
const clientIp = document.getElementById("clientIp");
const clientUa = document.getElementById("clientUa");
const gauge = document.getElementById("speedGauge");
const gaugeMode = document.getElementById("gaugeMode");
const gaugeValue = document.getElementById("gaugeValue");
const gaugeUnit = document.getElementById("gaugeUnit");
const steps = Array.from(document.querySelectorAll(".step-item"));
const pageConfig = window.SPEEDTEST_CONFIG || {};

const LATENCY_SAMPLES = 20;
const LATENCY_INTERVAL_MS = 1000;
const DOWNLOAD_TARGET_SECONDS = Number(pageConfig.downloadDurationSeconds) || 8;
const UPLOAD_TARGET_SECONDS = Number(pageConfig.uploadDurationSeconds) || 8;
const UPLOAD_REQUEST_BYTES = 8 * 1024 * 1024;

let running = false;

startButton.addEventListener("click", runSpeedtest);
retryButton.addEventListener("click", runSpeedtest);

resetView();
renderClientInfo();
renderGauge(0, "idle");

async function runSpeedtest() {
  if (running) {
    return;
  }

  running = true;
  startButton.disabled = true;
  retryButton.hidden = true;
  setPhase("running", "测速进行中");
  resetMetrics();

  try {
    setActiveStep("latency");
    setGaugeMode("延迟测试");
    statusText.textContent = "正在进行延迟测试，每秒 1 次，共 20 次。";
    const latencyResults = await runLatencySuite();
    renderLatency(latencyResults);
    setCompletedStep("latency");

    setActiveStep("download");
    setGaugeMode("下载测速");
    statusText.textContent = "正在进行下载测速。";
    const downloadMbps = await runDownloadTest();
    downloadHeadline.textContent = formatGaugeNumber(downloadMbps);
    renderGauge(downloadMbps, "download");
    setCompletedStep("download");

    setActiveStep("upload");
    setGaugeMode("上传测速");
    statusText.textContent = "正在进行上传测速。";
    const uploadMbps = await runUploadTest();
    uploadHeadline.textContent = formatGaugeNumber(uploadMbps);
    renderGauge(uploadMbps, "upload");
    setCompletedStep("upload");

    setPhase("done", "测速完成");
    setGaugeMode("测速完成");
    statusText.textContent = "测速完成，可以查看上方结果。";
  } catch (error) {
    console.error(error);
    setPhase("error", "测速失败");
    setGaugeMode("测速失败");
    statusText.textContent = error instanceof Error ? error.message : "测速失败，请稍后重试。";
  } finally {
    running = false;
    startButton.disabled = false;
    retryButton.hidden = false;
  }
}

async function runLatencySuite() {
  const results = [];
  for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
    const result = await measureLatency(index + 1);
    results.push(result);
    renderLatency(results);
    if (index < LATENCY_SAMPLES - 1) {
      await sleep(LATENCY_INTERVAL_MS);
    }
  }
  return results;
}

async function measureLatency(sampleNumber) {
  const requestUrl = `/api/ping?sample=${sampleNumber}&t=${Date.now()}`;
  const start = performance.now();

  try {
    const response = await fetch(requestUrl, {
      method: "GET",
      cache: "no-store",
      headers: { "Cache-Control": "no-store" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    await response.json();
    const duration = performance.now() - start;
    renderGauge(duration, "latency");
    return { sampleNumber, ok: true, duration };
  } catch (error) {
    return {
      sampleNumber,
      ok: false,
      error: error instanceof Error ? error.message : "请求失败",
    };
  }
}

async function runDownloadTest() {
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TARGET_SECONDS * 1000);
  let bytesRead = 0;

  try {
    const response = await fetch(`/api/download?t=${Date.now()}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error("下载测速接口不可用");
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      renderGauge(toMbps(bytesRead, performance.now() - startedAt), "download");
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      throw new Error("下载测速失败");
    }
  } finally {
    clearTimeout(timeoutId);
  }

  const elapsedMs = performance.now() - startedAt;
  if (bytesRead <= 0 || elapsedMs <= 0) {
    throw new Error("下载测速失败");
  }

  return toMbps(bytesRead, elapsedMs);
}

async function runUploadTest() {
  const startedAt = performance.now();
  const targetMs = UPLOAD_TARGET_SECONDS * 1000;
  const payload = new Uint8Array(UPLOAD_REQUEST_BYTES);
  let uploadedBytes = 0;
  let requestCount = 0;

  while (performance.now() - startedAt < targetMs || uploadedBytes === 0) {
    requestCount += 1;

    const response = await fetch(`/api/upload?t=${Date.now()}&part=${requestCount}`, {
      method: "POST",
      body: payload,
      cache: "no-store",
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });

    if (!response.ok) {
      throw new Error(response.status === 413 ? "上传数据超过服务器限制" : "上传测速失败");
    }

    const result = await response.json();
    uploadedBytes += Number(result.receivedBytes) || payload.byteLength;
    renderGauge(toMbps(uploadedBytes, performance.now() - startedAt), "upload");
  }

  const elapsedMs = performance.now() - startedAt;
  if (uploadedBytes <= 0 || elapsedMs <= 0) {
    throw new Error("上传测速失败");
  }

  return toMbps(uploadedBytes, elapsedMs);
}

function renderLatency(results) {
  const successful = results.filter((item) => item.ok).map((item) => item.duration);
  const failures = results.length - successful.length;

  latencyCount.textContent = `${results.length} / ${LATENCY_SAMPLES}`;
  renderLatencyChart(results);

  if (successful.length === 0) {
    latencySummary.textContent = "暂无有效延迟";
    avgLatency.textContent = "--";
    minLatency.textContent = "--";
    maxLatency.textContent = "Max --";
    jitterLatency.textContent = "--";
    latencyMeta.textContent = failures > 0 ? `当前失败 ${failures} 次` : "尚未开始测速";
    return;
  }

  const average = successful.reduce((sum, value) => sum + value, 0) / successful.length;
  const minimum = Math.min(...successful);
  const maximum = Math.max(...successful);
  const jitter = calculateJitter(successful);

  latencySummary.textContent = `${average.toFixed(1)} ms`;
  avgLatency.textContent = `${average.toFixed(1)} ms`;
  minLatency.textContent = `${minimum.toFixed(1)} ms`;
  maxLatency.textContent = `Max ${maximum.toFixed(1)} ms`;
  jitterLatency.textContent = `${jitter.toFixed(1)} ms`;
  latencyMeta.textContent = failures > 0 ? `成功 ${successful.length} 次，失败 ${failures} 次` : `20 次延迟测试进行中或已完成`;
}

function renderLatencyChart(results) {
  if (results.length === 0) {
    latencyChart.className = "latency-chart-empty";
    latencyChart.textContent = "等待测速开始";
    return;
  }

  const width = 960;
  const height = 288;
  const padding = { top: 22, right: 22, bottom: 38, left: 56 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const successful = results.filter((item) => item.ok);
  const successfulValues = successful.map((item) => item.duration);
  const minValue = successfulValues.length > 0 ? Math.min(...successfulValues) : 0;
  const maxValue = successfulValues.length > 0 ? Math.max(...successfulValues) : 100;
  const paddedMax = Math.max(maxValue * 1.1, minValue + 5, 10);
  const paddedMin = Math.max(0, Math.min(minValue * 0.9, paddedMax - 5));
  const range = Math.max(paddedMax - paddedMin, 1);

  const xFor = (sampleNumber) => {
    if (LATENCY_SAMPLES === 1) {
      return padding.left + chartWidth / 2;
    }
    return padding.left + ((sampleNumber - 1) / (LATENCY_SAMPLES - 1)) * chartWidth;
  };

  const yFor = (value) => padding.top + chartHeight - ((value - paddedMin) / range) * chartHeight;
  const gridValues = [paddedMax, paddedMin + range / 2, paddedMin];
  const points = successful
    .map((item) => `${xFor(item.sampleNumber).toFixed(2)},${yFor(item.duration).toFixed(2)}`)
    .join(" ");

  const circles = results
    .map((item) => {
      const x = xFor(item.sampleNumber).toFixed(2);
      if (!item.ok) {
        const y = (padding.top + chartHeight - 8).toFixed(2);
        return `
          <g>
            <line x1="${(Number(x) - 4).toFixed(2)}" y1="${(Number(y) - 4).toFixed(2)}" x2="${(Number(x) + 4).toFixed(2)}" y2="${(Number(y) + 4).toFixed(2)}" stroke="#b13e2d" stroke-width="2" stroke-linecap="round"></line>
            <line x1="${(Number(x) + 4).toFixed(2)}" y1="${(Number(y) - 4).toFixed(2)}" x2="${(Number(x) - 4).toFixed(2)}" y2="${(Number(y) + 4).toFixed(2)}" stroke="#b13e2d" stroke-width="2" stroke-linecap="round"></line>
          </g>
        `;
      }
      const y = yFor(item.duration).toFixed(2);
      return `<circle cx="${x}" cy="${y}" r="4.5" fill="#b45f2a" stroke="#fffaf2" stroke-width="2"></circle>`;
    })
    .join("");

  const xLabels = [1, 5, 10, 15, 20]
    .map((value) => {
      const x = xFor(value).toFixed(2);
      return `<text x="${x}" y="${height - 10}" text-anchor="middle" fill="#6b6257" font-size="12">${value}</text>`;
    })
    .join("");

  const yLabels = gridValues
    .map((value) => {
      const y = yFor(value).toFixed(2);
      return `
        <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(96, 70, 42, 0.12)" stroke-dasharray="4 6"></line>
        <text x="${padding.left - 10}" y="${Number(y) + 4}" text-anchor="end" fill="#6b6257" font-size="12">${value.toFixed(1)} ms</text>
      `;
    })
    .join("");

  const pathMarkup =
    successful.length > 1
      ? `<polyline points="${points}" fill="none" stroke="#b45f2a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>`
      : "";

  latencyChart.className = "";
  latencyChart.innerHTML = `
    <svg class="latency-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="延迟测试图表">
      <rect x="${padding.left}" y="${padding.top}" width="${chartWidth}" height="${chartHeight}" rx="18" fill="rgba(35, 40, 72, 0.84)"></rect>
      ${yLabels}
      ${pathMarkup}
      ${circles}
      ${xLabels}
      <text x="${padding.left}" y="${height - 10}" fill="#6b6257" font-size="12">采样次数</text>
    </svg>
  `;
}

function calculateJitter(values) {
  if (values.length < 2) {
    return 0;
  }

  let total = 0;
  for (let index = 1; index < values.length; index += 1) {
    total += Math.abs(values[index] - values[index - 1]);
  }
  return total / (values.length - 1);
}

function resetView() {
  resetMetrics();
  retryButton.hidden = true;
}

function resetMetrics() {
  steps.forEach((step) => {
    step.classList.remove("active", "complete");
  });
  latencyCount.textContent = `0 / ${LATENCY_SAMPLES}`;
  latencySummary.textContent = "--";
  avgLatency.textContent = "--";
  minLatency.textContent = "--";
  maxLatency.textContent = "Max --";
  jitterLatency.textContent = "--";
  latencyMeta.textContent = "尚未开始测速";
  renderLatencyChart([]);
  downloadHeadline.textContent = "--";
  uploadHeadline.textContent = "--";
  gaugeValue.textContent = "0.00";
  gaugeUnit.textContent = "Mbps";
  setGaugeMode("准备开始");
  renderGauge(0, "idle");
  setPhase("idle", "等待开始");
}

function renderClientInfo() {
  clientIp.textContent = pageConfig.clientIp || "未知";
  clientUa.textContent = pageConfig.userAgent || "未知";
}

function renderGauge(value, mode) {
  const labels = [0, 5, 10, 50, 100, 250, 500, 750, 1000];
  const cx = 280;
  const cy = 315;
  const radius = 205;
  const startDeg = -132;
  const endDeg = 132;
  const baseArc = describeArc(cx, cy, radius, startDeg, endDeg);
  const progressRatio = normalizeGaugeValue(value, mode);
  const progressEndDeg = startDeg + (endDeg - startDeg) * progressRatio;
  const progressArc = progressRatio > 0.001 ? describeArc(cx, cy, radius, startDeg, progressEndDeg) : "";
  const needleLength = 152;
  const needleAngle = startDeg + (endDeg - startDeg) * progressRatio;
  const needleTip = polarToCartesian(cx, cy, needleLength, needleAngle);
  const needleLeft = polarToCartesian(cx, cy, 22, needleAngle - 92);
  const needleRight = polarToCartesian(cx, cy, 22, needleAngle + 92);
  const labelMarkup = labels
    .map((label) => {
      const ratio = normalizeGaugeValue(label, "speed");
      const angle = startDeg + (endDeg - startDeg) * ratio;
      const point = polarToCartesian(cx, cy, radius - 48, angle);
      return `<text x="${point.x.toFixed(2)}" y="${(point.y + 7).toFixed(2)}" text-anchor="middle" fill="rgba(247, 248, 255, 0.58)" font-size="18" font-weight="600">${label}</text>`;
    })
    .join("");

  const color = mode === "upload" ? "#b56cff" : mode === "latency" ? "#f6ea73" : "#5bf7ff";
  const arcStroke = mode === "upload" ? "url(#speedArcUpload)" : "url(#speedArcDownload)";
  const gaugeTextValue = mode === "latency" ? value.toFixed(1) : formatGaugeNumber(value);

  gauge.innerHTML = `
    <defs>
      <linearGradient id="speedArcDownload" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#b56cff"></stop>
        <stop offset="50%" stop-color="#c960ff"></stop>
        <stop offset="100%" stop-color="#5bf7ff"></stop>
      </linearGradient>
      <linearGradient id="speedArcUpload" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#5bf7ff"></stop>
        <stop offset="100%" stop-color="#b56cff"></stop>
      </linearGradient>
      <linearGradient id="needleGradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"></stop>
        <stop offset="100%" stop-color="rgba(42, 59, 102, 0.08)"></stop>
      </linearGradient>
      <filter id="needleGlow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="8" stdDeviation="18" flood-color="${color}" flood-opacity="0.22"></feDropShadow>
      </filter>
    </defs>
    <path d="${baseArc}" fill="none" stroke="rgba(42, 59, 102, 0.94)" stroke-width="38" stroke-linecap="butt"></path>
    ${progressArc ? `<path d="${progressArc}" fill="none" stroke="${arcStroke}" stroke-width="38" stroke-linecap="butt"></path>` : ""}
    ${labelMarkup}
    <path d="M ${needleLeft.x.toFixed(2)} ${needleLeft.y.toFixed(2)} L ${needleTip.x.toFixed(2)} ${needleTip.y.toFixed(2)} L ${needleRight.x.toFixed(2)} ${needleRight.y.toFixed(2)} Z" fill="url(#needleGradient)" filter="url(#needleGlow)"></path>
    <circle cx="${cx}" cy="${cy}" r="15" fill="#1f223d"></circle>
    <circle cx="${cx}" cy="${cy}" r="7" fill="${color}"></circle>
  `;

  gaugeValue.textContent = gaugeTextValue;
  gaugeUnit.textContent = mode === "latency" ? "ms" : "Mbps";
}

function setGaugeMode(label) {
  gaugeMode.textContent = label;
}

function normalizeGaugeValue(value, mode) {
  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  if (mode === "latency") {
    return Math.min(Math.log10(safeValue + 1) / Math.log10(1001), 1);
  }
  return Math.min(Math.log10(safeValue + 1) / Math.log10(1001), 1);
}

function polarToCartesian(cx, cy, radius, angleInDegrees) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
}

function describeArc(cx, cy, radius, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function formatGaugeNumber(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function setPhase(phase, label) {
  phaseBadge.textContent = label;
  phaseBadge.dataset.phase = phase;
}

function setActiveStep(name) {
  steps.forEach((step) => {
    step.classList.toggle("active", step.dataset.step === name);
  });
}

function setCompletedStep(name) {
  steps.forEach((step) => {
    if (step.dataset.step === name) {
      step.classList.remove("active");
      step.classList.add("complete");
    }
  });
}

function toMbps(bytes, elapsedMs) {
  return (bytes * 8) / 1_000_000 / (elapsedMs / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
