import {createHash, randomUUID} from 'node:crypto';
import {validateAvatarPng, validateAvatarScene, type AgentAvatar, type AvatarScene} from './agent-avatar.js';

/** Keep the illustration's geometry and visual identity; vary its palette. */
export function varyAvatarScene(input: AvatarScene, seed = randomUUID()): AvatarScene {
  if (typeof seed !== 'string' || seed.length > 4096) throw new Error('이미지 변형 식별자가 올바르지 않습니다.');
  const scene = validateAvatarScene(input), bytes = createHash('sha256').update('venditbot-avatar-variation-v1\0').update(seed).digest();
  const shift = [16 + bytes[0]! % 24, -(12 + bytes[1]! % 20), 10 + bytes[2]! % 24];
  const transform = (value: string): string => {
    if (value === 'none') return value;
    const hex = value.slice(1), full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
    return '#' + [0, 1, 2].map((i) => {
      const n = Number.parseInt(full.slice(i * 2, i * 2 + 2), 16), delta = shift[i]!;
      // Reflect at the edges instead of clamping all-white/all-black palettes.
      const changed = n + delta;
      return (changed > 255 ? n - Math.abs(delta) : changed < 0 ? n + Math.abs(delta) : changed).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  };
  return validateAvatarScene({background: transform(scene.background), shapes: scene.shapes.map(shape => ({...shape,
    ...(typeof shape.fill === 'string' ? {fill: transform(shape.fill)} : {}),
    ...(typeof shape.stroke === 'string' ? {stroke: transform(shape.stroke)} : {}),
  }))});
}

/** Only an app-owned, validated PNG can become a provider reference. */
export function referenceAvatarImage(asset: AgentAvatar): {bytes: Uint8Array; mimeType: 'image/png'} | undefined {
  if (asset.kind !== 'image') return undefined;
  const prefix = 'data:image/png;base64,';
  if (!asset.dataUrl.startsWith(prefix)) throw new Error('참고 이미지는 저장된 PNG만 사용할 수 있습니다.');
  const encoded = asset.dataUrl.slice(prefix.length);
  if (encoded.length > Math.ceil(2 * 1024 * 1024 / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('참고 이미지 형식 또는 크기가 올바르지 않습니다.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('참고 이미지 데이터가 올바르지 않습니다.');
  return {bytes: validateAvatarPng(bytes), mimeType: 'image/png'};
}
