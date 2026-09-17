import { Card } from "./Card";

// A sibling import (`./Card`), the form that page-relative recognition misses.
export function Wrapper() {
  return <Card class="p-5 flex flex-col gap-4">sibling</Card>;
}
