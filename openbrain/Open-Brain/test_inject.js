function injectTextViaPaste(input, text) {
  input.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  const pasteEvt = new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(pasteEvt);
}
