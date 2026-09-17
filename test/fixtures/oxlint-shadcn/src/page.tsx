import { Card } from "./components/Card";

export function Page() {
  return (
    <>
      <Card class="p-5">caller-side padding collision</Card>
      <Card class="mt-4 flex flex-col gap-4">placement and gap are the caller's</Card>
    </>
  );
}
