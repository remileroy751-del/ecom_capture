'use strict';
const el = document.getElementById('n');
window.api.onCountdown((n) => {
  el.textContent = String(n);
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
});
