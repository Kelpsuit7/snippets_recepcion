const activationLabel = document.querySelector('[data-activation-label]');
const validThemes = new Set(['mint', 'rose', 'sky', 'lavender', 'peach']);

window.tooltipApi.onDetected((payload) => {
  const activationLabels = {
    shift: 'SHIFT',
    'double-shift': 'SHIFT x2',
  };
  const label = activationLabels[payload.activationMode];

  if (!label) {
    document.body.hidden = true;
    return;
  }

  document.body.dataset.theme = validThemes.has(payload.theme) ? payload.theme : 'mint';
  activationLabel.textContent = label;
  document.body.hidden = false;
  window.tooltipApi.rendered();
});
