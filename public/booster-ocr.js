// 打手端：截图框选 + 本地 OCR 识别（Tesseract.js，浏览器内运行，截图不出设备）
//
// 识别流程（已用真实截图在 Node 端用同款引擎验证）：
//   框选区域 → 原分辨率截取（最近邻不模糊）→ 灰度/拉伸/二值化/按需反相
//   → 行投影自动分出文字行 → 自底向上逐行 OCR，取第一条能解析出数字的结果
//   （框里混入「总资产 ?」标签行、或框得过大带进别的行，都不影响结果）。
// 默认框选区域：按真实游戏截图「角色-战绩」页标定。
// 「总资产」标签 + 数值（如 170.9M）上下结构，位于画面中部偏右上。
// 用相对比例（0~1）存储，任何分辨率的横屏截图都适用；若某台手机有偏移，
// 手动重框一次即自动记住（localStorage），之后每次都是固定位置。
(function () {
  var DEFAULT_REGION = { left: 0.48, top: 0.285, width: 0.12, height: 0.115 };
  var REGION_KEY = 'boosterOcrRegion'; // 两张截图版式相同，共用一个记忆区域

  // ---------------------------------------------------------------------------
  // 引擎加载：脚本懒加载 + worker 单例复用
  // 原先每次「识别一条文字带」都调用一次 Tesseract.recognize()，而 recognize()
  // 内部会 createWorker → 加载 core → 加载 eng 语言包 → 用完即 terminate，
  // 于是逐行回退时每试一条带就要重新加载一遍 ~15MB 的核心与语言包。
  // 现在：脚本按需加载一次，worker 建一次并复用，之后只调 worker.recognize()。
  // ---------------------------------------------------------------------------
  var TESS_SCRIPT = '/ocr/tesseract.min.js';
  var CONFIDENCE_WARN = 60; // 置信度低于此值（0~100）时强提醒核对
  var tessScriptPromise = null;
  var workerPromise = null;

  function loadTessScript() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tessScriptPromise) return tessScriptPromise;
    tessScriptPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = TESS_SCRIPT;
      s.onload = function () {
        window.Tesseract ? resolve(window.Tesseract)
                         : reject(new Error('引擎脚本已加载，但 Tesseract 未定义'));
      };
      s.onerror = function () {
        tessScriptPromise = null; // 允许下次点击重试
        reject(new Error('OCR 引擎脚本加载失败，请检查网络后重试'));
      };
      document.head.appendChild(s);
    });
    return tessScriptPromise;
  }

  // WASM SIMD 能力探测：支持就用 simd 版核心（明显更快），不支持回退普通版。
  function simdSupported() {
    try {
      return typeof WebAssembly !== 'undefined' && WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
        3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
      ]));
    } catch (e) { return false; }
  }

  function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = loadTessScript().then(function (T) {
      // OEM 1 = 仅 LSTM；配 lstm 专用核心（比含传统引擎的 full 核心小 ~25%）
      return T.createWorker('eng', 1, {
        workerPath: '/ocr/worker.min.js',
        corePath: simdSupported()
          ? '/ocr/tesseract-core-simd-lstm.wasm.js'
          : '/ocr/tesseract-core-lstm.wasm.js',
        langPath: '/ocr/lang'
      });
    }).then(function (w) {
      return w.setParameters({
        tessedit_char_whitelist: '0123456789.,MKB',
        tessedit_pageseg_mode: 7,          // 单行文本（已按行分割）
        tessedit_ocr_engine_mode: 1        // 仅 LSTM 引擎，数字识别更稳定
      }).then(function () { return w; });
    }).catch(function (e) {
      workerPromise = null; // 失败后允许下次点击重试
      throw e;
    });
    return workerPromise;
  }

  // 置信度提醒：不拦住提交，但把输入框标红 + 给出提示，避免错数直接进账
  function flagConfidence(input, conf) {
    var tip = input.parentNode.querySelector('.ocr-conf-tip');
    if (typeof conf === 'number' && conf < CONFIDENCE_WARN) {
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'ocr-conf-tip';
        input.parentNode.appendChild(tip);
      }
      tip.style.cssText = 'margin-top:4px;font-size:12px;color:#a32d2d';
      tip.textContent = '识别置信度 ' + Math.round(conf) + '%（偏低），请对照截图仔细核对';
      input.style.borderColor = '#e24b4a';
      input.style.background = '#fcebeb';
    } else {
      if (tip) { tip.textContent = ''; tip.style.display = 'none'; }
      input.style.borderColor = '';
      input.style.background = '';
    }
  }

  function loadRegion() {
    try {
      var s = JSON.parse(localStorage.getItem(REGION_KEY));
      if (s && s.left > 0 && s.top >= 0 && s.width > 0 && s.height > 0 &&
          s.left + s.width <= 1.01 && s.top + s.height <= 1.01) return s;
    } catch (e) {}
    return DEFAULT_REGION;
  }
  function saveRegion(r) {
    try { localStorage.setItem(REGION_KEY, JSON.stringify(r)); } catch (e) {}
  }
  function clearRegion() {
    try { localStorage.removeItem(REGION_KEY); } catch (e) {}
  }

  function setupCropper(fileInput, canvas) {
    var ctx = canvas.getContext('2d');
    var img = new Image();
    var scale = 1;
    var rect = null, drawing = false, sx = 0, sy = 0;

    function applyRegion(r) {
      rect = {
        x: r.left * canvas.width,
        y: r.top * canvas.height,
        w: r.width * canvas.width,
        h: r.height * canvas.height
      };
      redraw();
    }
    function toRegion() {
      if (!rect || rect.w < 5 || rect.h < 5) return null;
      return {
        left: rect.x / canvas.width,
        top: rect.y / canvas.height,
        width: rect.w / canvas.width,
        height: rect.h / canvas.height
      };
    }

    fileInput.addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      img.onload = function () {
        var maxW = 340;
        scale = Math.min(maxW / img.naturalWidth, 1);
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        applyRegion(loadRegion()); // 载入即预定位到「总资产」位置
      };
      img.src = URL.createObjectURL(f);
    });

    function pos(evt) {
      var r = canvas.getBoundingClientRect();
      var cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - r.left;
      var cy = (evt.touches ? evt.touches[0].clientY : evt.clientY) - r.top;
      // CSS 显示尺寸与画布内部尺寸可能不同，必须映射
      var kx = canvas.width / r.width, ky = canvas.height / r.height;
      return { x: cx * kx, y: cy * ky };
    }
    function down(e) { e.preventDefault(); drawing = true; var p = pos(e); sx = p.x; sy = p.y; rect = { x: sx, y: sy, w: 0, h: 0 }; }
    function move(e) { if (!drawing) return; e.preventDefault(); var p = pos(e); rect = { x: Math.min(sx, p.x), y: Math.min(sy, p.y), w: Math.abs(p.x - sx), h: Math.abs(p.y - sy) }; redraw(); }
    function up() {
      if (!drawing) return;
      drawing = false;
      var r = toRegion();
      if (r) saveRegion(r); // 手动框选一次即记住
    }
    function redraw() {
      if (!img.naturalWidth) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (rect && rect.w > 4 && rect.h > 4) {
        ctx.strokeStyle = '#1a73e8'; ctx.lineWidth = 2; ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1; ctx.strokeRect(rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4);
      }
    }
    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    canvas.addEventListener('touchstart', down, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', up);

    return {
      // 生成 OCR 候选图列表：框内自动按行分割，从最底部的文字带开始
      // （「总资产 ?」标签在数值上方，数值行是最底部文字带；若只框了数字则只有一条带）
      ocrBands: function () {
        if (!rect || rect.w < 5 || rect.h < 5) return null;
        var sxN = rect.x / scale, syN = rect.y / scale, sw = rect.w / scale, sh = rect.h / scale;
        // 向外扩 4% 边距，避免把数字顶/底裁掉
        var mx = Math.max(2, sw * 0.04), my = Math.max(2, sh * 0.04);
        sxN = Math.max(0, sxN - mx); syN = Math.max(0, syN - my);
        sw = Math.min(img.naturalWidth - sxN, sw + mx * 2);
        sh = Math.min(img.naturalHeight - syN, sh + my * 2);
        // 1) 原分辨率截取（最近邻，不平滑，保留笔画锐度）
        var c0 = document.createElement('canvas');
        c0.width = Math.max(1, Math.round(sw));
        c0.height = Math.max(1, Math.round(sh));
        var cc0 = c0.getContext('2d');
        cc0.imageSmoothingEnabled = false;
        cc0.drawImage(img, sxN, syN, sw, sh, 0, 0, c0.width, c0.height);
        // 2) 灰度 + 对比度拉伸 + 二值化 + 按需反相
        var binData = binarizeCanvas(cc0, c0.width, c0.height);
        // 3) 行投影找文字带，自底向上生成候选
        var bands = textBands(binData, c0.width, c0.height);
        var list = [];
        for (var i = bands.length - 1; i >= 0; i--) {
          list.push(bandCanvas(binData, c0.width, c0.height, bands[i][0], bands[i][1]));
        }
        if (!list.length) list.push(scaleUpCanvas(c0)); // 兜底：找不到行就整块送 OCR
        return list;
      },
      resetRegion: function () {
        clearRegion();
        applyRegion(DEFAULT_REGION);
      }
    };
  }

  // 预处理：灰度 → Otsu 自适应阈值二值化 → 按需反相，输出干净黑白图。
  // 关键：先在原分辨率二值化再整数放大，避免双线性模糊把「9」的小环抹成「8」。
  // 阈值由 Otsu 按当前截图的灰度直方图自动求出，取代原先写死的 127 ——
  // 渐变背景、局部高光、整体偏暗的截图都能自适应，固定阈值在这几种情况下会成片糊掉。
  function binarizeCanvas(cc, w, h) {
    var d = cc.getImageData(0, 0, w, h), px = d.data;
    var n = w * h, gray = new Float32Array(n);
    var hist = new Int32Array(256), min = 255, max = 0;
    for (var i = 0, g = 0; i < px.length; i += 4, g++) {
      var v = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      gray[g] = v;
      hist[v]++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // 几乎纯色块时 Otsu 无意义，退化为中值阈值，避免整片全黑或全白
    var thr = (max - min < 20) ? (min + max) / 2 : otsuThreshold(hist, n);
    var out = cc.createImageData(w, h), op = out.data;
    var dark = 0;
    for (var g2 = 0; g2 < n; g2++) {
      var bw = gray[g2] > thr ? 255 : 0;
      if (bw === 0) dark++;
      op[g2 * 4] = op[g2 * 4 + 1] = op[g2 * 4 + 2] = bw;
      op[g2 * 4 + 3] = 255;
    }
    // 前景黑像素过半 = 浅色字压在暗底上 → 反相成黑字白底，Tesseract 更稳
    if (dark > n * 0.5) {
      for (var k = 0; k < op.length; k += 4) {
        op[k] = op[k + 1] = op[k + 2] = 255 - op[k];
      }
    }
    cc.putImageData(out, 0, 0);
    return op;
  }

  // Otsu：遍历 0~255，取使「前景/背景类间方差」最大的灰度，并返回该区间的中点。
  // 取中点而非首个最大值：直方图常出现「连续多个 t 方差完全相同」的平台，
  // 只取最左会把阈值压到偏暗一侧，二值化时对噪声和高光不够稳。
  function otsuThreshold(hist, total) {
    var i, t, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var wB = 0, sumB = 0, best = -1, lo = 127, hi = 127;
    for (t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best + 1e-9) { best = between; lo = t; hi = t; }
      else if (best - between <= 1e-9) { hi = t; } // 与最优持平：扩展平台右端
    }
    return (lo + hi) / 2;
  }

  // 行投影：每行黑像素占比 > 1.5% 视为文字行，返回 [[y0,y1],...]（含 ≤2px 缝隙合并）
  function textBands(bin, w, h) {
    var bands = [], start = -1, y, x, dark;
    for (y = 0; y < h; y++) {
      dark = 0;
      for (x = 0; x < w; x++) if (bin[(y * w + x) * 4] < 128) dark++;
      var on = dark / w > 0.015;
      if (on && start < 0) start = y;
      if (!on && start >= 0) { bands.push([start, y - 1]); start = -1; }
    }
    if (start >= 0) bands.push([start, h - 1]);
    var merged = [];
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      if (merged.length && b[0] - merged[merged.length - 1][1] <= 2) merged[merged.length - 1][1] = b[1];
      else merged.push(b);
    }
    return merged;
  }

  // 把一条文字带裁出（上下留 6px），整数倍最近邻放大 + 白边，喂给 Tesseract
  function bandCanvas(bin, w, h, b0, b1) {
    var y0 = Math.max(0, b0 - 6), y1 = Math.min(h - 1, b1 + 6), bh = y1 - y0 + 1;
    var band = document.createElement('canvas');
    band.width = w; band.height = bh;
    var bctx = band.getContext('2d');
    var imgData = bctx.createImageData(w, bh);
    for (var yy = 0; yy < bh; yy++) {
      for (var xx = 0; xx < w; xx++) {
        var si = ((y0 + yy) * w + xx) * 4, di = (yy * w + xx) * 4;
        imgData.data[di] = bin[si];
        imgData.data[di + 1] = bin[si + 1];
        imgData.data[di + 2] = bin[si + 2];
        imgData.data[di + 3] = 255;
      }
    }
    bctx.putImageData(imgData, 0, 0);
    return scaleUpCanvas(band);
  }

  // 整数倍最近邻放大到 ~500px 宽，外加白边
  function scaleUpCanvas(src) {
    var f = Math.max(3, Math.round(500 / Math.max(1, src.width))), pad = 10;
    var c = document.createElement('canvas');
    c.width = src.width * f + pad * 2;
    c.height = src.height * f + pad * 2;
    var cc = c.getContext('2d');
    cc.imageSmoothingEnabled = false;
    cc.fillStyle = '#fff';
    cc.fillRect(0, 0, c.width, c.height);
    cc.drawImage(src, 0, 0, src.width, src.height, pad, pad, src.width * f, src.height * f);
    return c;
  }

  // 解析 "123.4M" / "1,234.5万" 等。系统统一以「百万(M)」为单位存储金额：
  // 识别到 107.9M → 存入 107.9（M 即默认单位，不再乘 1e6）；
  // 其它单位（K/万/亿）换算到百万后存入，保证全系统单位一致。
  function parseAmount(text, fallbackUnit) {
    if (!text) return null;
    var m = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(M|K|B|亿|万|千)?/i);
    if (!m) return null;
    var num = parseFloat(m[1]);
    if (isNaN(num)) return null;
    var unit = (m[2] || '').toUpperCase() || fallbackUnit;
    // 换算到「百万(M)」的系数：M=原值，K/千=1/1000，万=1/100，亿=×100，B=×1000
    var toM = { 'M': 1, 'K': 0.001, 'B': 1000, '亿': 100, '万': 0.01, '千': 0.001 }[unit] || 1;
    var val = num * toM;
    return Math.round(val * 100) / 100; // 保留 2 位小数，去掉浮点误差
  }

  function setupSlot(prefix) {
    var fileInput = document.querySelector('input[type=file][data-role="' + prefix + '"]');
    var canvas = document.querySelector('canvas[data-role="' + prefix + '"]');
    var amountInput = document.getElementById(prefix + '_amount');
    var recBtn = document.querySelector('button[data-recognize="' + prefix + '"]');
    var resetBtn = document.querySelector('button[data-reset="' + prefix + '"]');
    if (!fileInput || !canvas || !amountInput || !recBtn) return;
    var cropper = setupCropper(fileInput, canvas);
    if (resetBtn) resetBtn.addEventListener('click', function () { cropper.resetRegion(); });
    recBtn.addEventListener('click', function () {
      var bands = cropper.ocrBands();
      if (!bands) { alert('请先在截图上框选「总资产」数字区域'); return; }
      var unit = document.getElementById('unit').value;
      recBtn.disabled = true; var old = recBtn.textContent;
      function finish() { recBtn.disabled = false; recBtn.textContent = old; }
      // 首次点击才加载引擎（脚本 + core + 语言包）；后续点击直接复用已有 worker
      recBtn.textContent = '加载引擎…';
      getWorker().then(function (worker) {
        // 自底向上逐条文字带识别，取第一条能解析出数字的结果
        function tryBand(idx) {
          if (idx >= bands.length) {
            alert('识别失败，请手动输入金额，或点击「重置区域」后重新框选');
            finish();
            return;
          }
          recBtn.textContent = '识别中…';
          worker.recognize(bands[idx]).then(function (res) {
            var val = parseAmount(res.data.text, unit);
            if (val === null) { tryBand(idx + 1); return; } // 该带没有数字（如「总资产？」标签行），试上一条
            amountInput.value = val;
            flagConfidence(amountInput, res.data.confidence);
            finish();
          }).catch(function (err) {
            alert('识别出错：' + err.message);
            finish();
          });
        }
        tryBand(0);
      }).catch(function (err) {
        alert((err && err.message) || 'OCR 引擎加载失败');
        amountInput.focus();
        finish();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    setupSlot('start');
    setupSlot('end');
    // 提交前强制核对（开始 / 结束两个表单分别处理）
    var startForm = document.getElementById('startForm');
    if (startForm) startForm.addEventListener('submit', function (e) {
      var sa = document.getElementById('start_amount').value;
      if (!confirm('请核对：开始金额=' + sa + '（百万/M）。确认保存开始金额？\n（保存后你仍可几小时后再传结束截图）')) e.preventDefault();
    });
    var endForm = document.getElementById('endForm');
    if (endForm) endForm.addEventListener('submit', function (e) {
      var ea = document.getElementById('end_amount').value;
      if (!confirm('请核对：结束金额=' + ea + '（百万/M）。确认完成本轮？')) e.preventDefault();
    });
  });
})();
