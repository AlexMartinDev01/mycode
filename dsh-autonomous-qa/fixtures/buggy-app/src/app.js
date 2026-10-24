import { renderTotal } from './state.js';
const button = document.querySelector('#buy');
button.addEventListener('click', () => {
  const quantity = Number(document.querySelector('#quantity').value);
  document.querySelector('#total').textContent = String(renderTotal(100, quantity));
});
