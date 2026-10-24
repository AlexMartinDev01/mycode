import { calculateTotal } from './pricing.js';
export function renderTotal(price, quantity) {
  return calculateTotal(price, quantity);
}
