// The chart demo's notice (lib/demo.ts), the same words as every network demo's. Its own chunk,
// so the signed-in Portal's first load never carries it.
import { Banner } from "capsomer/react/banner";
import "capsomer/banner.css";

export function DemoNotice() {
  return (
    <Banner tone="info" title="Demo with sample data">
      This is how the page looks for a signed-in owner. The numbers are made up, and nothing here belongs to a real account.
    </Banner>
  );
}
