// FORK-PATCH(P-003): the favicon is rendered from the brand config
// (src/custom/brand/icon.tsx): by default the generated mark, identical
// to upstream's violet chat-square; or NEXT_PUBLIC_APP_FAVICON_URL.
// Node.js runtime instead of upstream's edge because a favicon path
// under public/ is read from disk. Next.js still renders this at build
// time and auto-injects <link rel="icon"> into <head>.
import { renderBrandIcon } from "@/custom/brand/icon";

export const runtime = "nodejs";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return renderBrandIcon(size);
}
