interface CorrectionSettings {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
}

export function applyColorCorrection(
  image: HTMLImageElement | HTMLCanvasElement,
  settings: CorrectionSettings
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  canvas.width = image.width;
  canvas.height = image.height;

  const brightnessVal = 1 + settings.brightness / 100;
  const contrastVal = 1 + settings.contrast / 100;
  const saturateVal = 1 + settings.saturation / 100;
  const tempOffset = (settings.temperature - 6500) / 6500;
  const sepiaVal = Math.abs(tempOffset) * 0.3;
  const hueVal = tempOffset > 0 ? -10 * tempOffset : 20 * Math.abs(tempOffset);
  const tintHue = settings.tint * 0.5;

  ctx.filter = [
    `brightness(${brightnessVal})`,
    `contrast(${contrastVal})`,
    `saturate(${saturateVal})`,
    `sepia(${sepiaVal})`,
    `hue-rotate(${hueVal + tintHue}deg)`,
  ].join(' ');

  ctx.drawImage(image, 0, 0);
  ctx.filter = 'none';

  return canvas;
}

export function applyColorTint(
  image: HTMLImageElement,
  color: string
): string | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  canvas.width = image.width;
  canvas.height = image.height;

  // 원본 이미지 그리기
  ctx.drawImage(image, 0, 0);

  // source-in: 기존 픽셀의 알파 영역에만 새 색상 적용
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalCompositeOperation = 'source-over';

  return canvas.toDataURL('image/png');
}

// 색상 기반 배경 제거: targetColor에 가까운 픽셀을 투명으로 변환
export function removeColorBackground(
  image: HTMLImageElement,
  targetColor: string,
  tolerance: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // targetColor hex → RGB
  const tr = parseInt(targetColor.slice(1, 3), 16);
  const tg = parseInt(targetColor.slice(3, 5), 16);
  const tb = parseInt(targetColor.slice(5, 7), 16);

  const tolSq = tolerance * tolerance;

  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - tr;
    const dg = data[i + 1] - tg;
    const db = data[i + 2] - tb;
    const distSq = dr * dr + dg * dg + db * db;

    if (distSq <= tolSq * 3) {
      // 거리에 따라 부드럽게 알파 감소
      const dist = Math.sqrt(distSq / 3);
      if (dist <= tolerance * 0.7) {
        data[i + 3] = 0;
      } else {
        const fade = (dist - tolerance * 0.7) / (tolerance * 0.3);
        data[i + 3] = Math.round(data[i + 3] * Math.min(fade, 1));
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
