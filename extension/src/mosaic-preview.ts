import { captureLayoutPreview } from "../../packages/core/render-recipe.ts";
import type { BlockPlan } from "../../packages/core/types.ts";

export function renderLayoutPreview(container: HTMLElement, plan: BlockPlan | undefined): void {
  container.textContent = ""; container.hidden = true;
  if (!plan) return;
  try {
    const preview = captureLayoutPreview(plan);
    if (!preview) { container.textContent = "Layout preview unavailable for this selection."; container.hidden = false; return; }
    const document = container.ownerDocument;
    const label = document.createElement("p"); label.className = "hint";
    label.textContent = preview.tiles.some(tile => tile.kind === "video") ? "Layout preview · videos shown as posters" : "Layout preview";
    const canvas = document.createElement("div"); canvas.className = "mosaic-layout-preview";
    canvas.style.aspectRatio = `${preview.width} / ${preview.height}`;
    for (const tile of preview.tiles) {
      const cell = document.createElement("div"); cell.className = "mosaic-layout-tile";
      cell.style.left = `${tile.rect.x / preview.width * 100}%`; cell.style.top = `${tile.rect.y / preview.height * 100}%`;
      cell.style.width = `${tile.rect.width / preview.width * 100}%`; cell.style.height = `${tile.rect.height / preview.height * 100}%`;
      if (tile.url) {
        const image = document.createElement("img"); image.src = tile.url; image.setAttribute("referrerpolicy", "no-referrer");
        image.alt = `${tile.kind === "video" ? "Video poster" : "Image"} ${tile.ref}`; cell.appendChild(image);
      } else { cell.textContent = `${tile.kind === "video" ? "Video" : "Image"} ${tile.ref} · preview unavailable`; }
      canvas.appendChild(cell);
    }
    container.appendChild(label); container.appendChild(canvas); container.hidden = false;
  } catch { container.textContent = "Layout preview unavailable for this selection."; container.hidden = false; }
}
