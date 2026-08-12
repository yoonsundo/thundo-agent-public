export async function removeImageBackground(
  imageBlob: Blob
): Promise<Blob> {
  const { removeBackground } = await import('@imgly/background-removal');
  const result = await removeBackground(imageBlob, {
    publicPath: 'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/',
    progress: (key: string, current: number, total: number) => {
      console.log(`[bg-removal] ${key}: ${current}/${total}`);
    },
  });
  return result;
}

export function blobToImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      // blob URL은 revoke하지 않음 — LayerCanvas에서 img.src로 렌더링에 필요
      // 레이어 삭제 시 removeLayer에서 정리
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image from blob'));
    };
    img.src = url;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to convert canvas to blob'));
    }, 'image/png');
  });
}
