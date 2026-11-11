'use strict';
const q = new URLSearchParams(location.search);
const v = document.getElementById('v');
if (q.get('mirror') === '1') v.classList.add('mirror');

async function start() {
  const dev = q.get('device');
  const base = { width: { ideal: 720 }, height: { ideal: 720 } };
  try {
    const video = dev ? { ...base, deviceId: { exact: dev } } : base;
    v.srcObject = await navigator.mediaDevices.getUserMedia({ video });
  } catch (_) {
    try {
      v.srcObject = await navigator.mediaDevices.getUserMedia({ video: base });
    } catch (e) {
      document.body.classList.add('err');
    }
  }
}
start();
document.getElementById('x').addEventListener('click', () => window.api.camClose());
