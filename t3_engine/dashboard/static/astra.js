document.addEventListener('DOMContentLoaded', function () { window.leadEngineStore.show(); });
document.addEventListener('visibilitychange', function () {
  if(document.hidden) window.leadEngineStore.hide(); else window.leadEngineStore.show();
});
