const startButton = document.getElementById("startButton");
const retryButton = document.getElementById("retryButton");
const statusText = document.getElementById("statusText");
const phaseBadge = document.getElementById("phaseBadge");
const latencySummary = document.getElementById("latencySummary");
const avgLatency = document.getElementById("avgLatency");
const minLatency = document.getElementById("minLatency");
const maxLatency = document.getElementById("maxLatency");
const jitterLatency = document.getElementById("jitterLatency");
const latencyMeta = document.getElementById("latencyMeta");
const latencyCount = document.getElementById("latencyCount");
const latencyList = document.getElementById("latencyList");
const downloadSpeed = document.getElementById("downloadSpeed");
const uploadSpeed = document.getElementById("uploadSpeed");
const steps = Array.from(document.querySelectorAll(".step-item"));
const pageConfig = window.SPEEDTEST_CONFIG || {};

const LATENCY_SAMPLES = 20;
const LATENCY_INTERVAL_MS = 1000;
const DOWNLOAD_TARGET_SECONDS = Number(pageConfig.downloadDurationSeconds) || 8;
const UPLOAD_TARGET_SECONDS = Number(pageConfig.uploadDurationSeconds) || 8;
const UPLOAD_CHUNK_BYTES = 256 * 1024;

let running = false;

startButton.addEventListener("click", runSpeedtest);
retryButton.addEventListener("click", runSpeedtest);

resetView();

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
    statusText.textContent = "正在进行延迟测试，每秒 1 次，共 20 次。";
    const latencyResults = await runLatencySuite();
    renderLatency(latencyResults);
    setCompletedStep("latency");

    setActiveStep("download");
    statusText.textContent = "正在进行下载测速。";
    const downloadMbps = await runDownloadTest();
    downloadSpeed.textContent = formatSpeed(downloadMbps);
    setCompletedStep("download");

    setActiveStep("upload");
    statusText.textContent = "正在进行上传测速。";
    const uploadMbps = await runUploadTest();
    uploadSpeed.textContent = formatSpeed(uploadMbps);
    setCompletedStep("upload");

    setPhase("done", "测速完成");
    statusText.textContent = "测速完成，可以查看上方结果。";
  } catch (error) {
    console.error(error);
    setPhase("error", "测速失败");
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
  const endTime = startedAt + UPLOAD_TARGET_SECONDS * 1000;
  let producedBytes = 0;
  let streamClosed = false;
  const chunk = new Uint8Array(UPLOAD_CHUNK_BYTES);

  const stream = new ReadableStream({
    pull(controller) {
      if (performance.now() >= endTime) {
        streamClosed = true;
        controller.close();
        return;
      }

      const clonedChunk = new Uint8Array(chunk);
      producedBytes += clonedChunk.byteLength;
      controller.enqueue(clonedChunk);
    },
    cancel() {
      streamClosed = true;
    },
  });

  const response = await fetch(`/api/upload?t=${Date.now()}`, {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: {
      "Content-Type": "application/octet-stream",
    },
  });

  if (!response.ok) {
    throw new Error(response.status === 413 ? "上传数据超过服务器限制" : "上传测速失败");
  }

  const payload = await response.json();
  const elapsedMs = performance.now() - startedAt;
  const measuredBytes = Number(payload.receivedBytes) || producedBytes;

  if (!streamClosed && elapsedMs < UPLOAD_TARGET_SECONDS * 1000 * 0.8) {
    throw new Error("上传测速提前结束");
  }

  if (measuredBytes <= 0 || elapsedMs <= 0) {
    throw new Error("上传测速失败");
  }

  return toMbps(measuredBytes, elapsedMs);
}

function renderLatency(results) {
  const successful = results.filter((item) => item.ok).map((item) => item.duration);
  const failures = results.length - successful.length;

  latencyCount.textContent = `${results.length} / ${LATENCY_SAMPLES}`;
  latencyList.innerHTML = results
    .map((item) => {
      if (!item.ok) {
        return `
          <article class="latency-item failed">
            <small>第 ${item.sampleNumber} 次</small>
            <strong>失败</strong>
          </article>
        `;
      }
      return `
        <article class="latency-item">
          <small>第 ${item.sampleNumber} 次</small>
          <strong>${item.duration.toFixed(1)} ms</strong>
        </article>
      `;
    })
    .join("");

  if (successful.length === 0) {
    latencySummary.textContent = "暂无有效延迟";
    avgLatency.textContent = "--";
    minLatency.textContent = "--";
    maxLatency.textContent = "--";
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
  maxLatency.textContent = `${maximum.toFixed(1)} ms`;
  jitterLatency.textContent = `${jitter.toFixed(1)} ms`;
  latencyMeta.textContent = failures > 0 ? `成功 ${successful.length} 次，失败 ${failures} 次` : `20 次延迟测试进行中或已完成`;
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
  latencyList.innerHTML = "";
  latencyCount.textContent = `0 / ${LATENCY_SAMPLES}`;
  latencySummary.textContent = "--";
  avgLatency.textContent = "--";
  minLatency.textContent = "--";
  maxLatency.textContent = "--";
  jitterLatency.textContent = "--";
  latencyMeta.textContent = "尚未开始测速";
  downloadSpeed.textContent = "--";
  uploadSpeed.textContent = "--";
  setPhase("idle", "等待开始");
}

function setPhase(phase, label) {
  phaseBadge.textContent = label;
  phaseBadge.className = `phase-badge ${phase}`;
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

function formatSpeed(value) {
  return `${value.toFixed(2)} Mbps`;
}

function toMbps(bytes, elapsedMs) {
  return (bytes * 8) / 1_000_000 / (elapsedMs / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
