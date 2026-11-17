"use strict";

/* 官网共享脚本：导航 active 状态、视频入场、动画 */

(function () {
  // 当前页面导航高亮
  const here = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav-links a, .hero-nav .nav-links a").forEach(function (a) {
    const href = a.getAttribute("href");
    if (href && href === here) a.classList.add("active");
    if (href && href.startsWith("provider") && here.startsWith("provider")) a.classList.add("active");
  });

  // hero 地球视频：有真实帧才淡入，尊重 reduced-motion
  const video = document.querySelector(".hero video.globe-video");
  if (video) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let started = false;
    let settled = false;

    function reveal() {
      if (settled) return;
      settled = true;
      video.classList.add("is-ready");
    }

    function start() {
      if (started || reduce.matches) return;
      started = true;
      video.preload = "auto";
      video.load();
      if (video.readyState >= 2) reveal();
      video.addEventListener("loadeddata", reveal, { once: true });
      video.addEventListener("playing", reveal, { once: true });
      const attempt = video.play();
      if (attempt && typeof attempt.catch === "function") attempt.catch(function () {});
    }

    start();
    if (typeof reduce.addEventListener === "function") {
      reduce.addEventListener("change", function (e) {
        if (e.matches) { started = false; settled = false; video.pause(); video.classList.remove("is-ready"); }
        else start();
      });
    }
  }
})();

/* 通用小工具：给 <pre> 加复制按钮 */
document.querySelectorAll("pre").forEach(function (pre) {
  var btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "复制";
  btn.style.cssText = "float:right;margin:-8px 0 8px 8px;font-size:12px;padding:5px 12px;";
  btn.addEventListener("click", function () {
    navigator.clipboard.writeText(pre.innerText).then(function () {
      btn.textContent = "已复制";
      setTimeout(function () { btn.textContent = "复制"; }, 1600);
    });
  });
  pre.appendChild(btn);
});
