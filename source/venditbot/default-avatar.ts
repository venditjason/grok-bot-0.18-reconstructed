import {createHash, randomBytes} from 'node:crypto';
import {validateAvatarScene, type AvatarScene} from './agent-avatar.js';

// Local default illustrations, never model-generated. Keep palettes coordinated
// so every seed remains readable as a small, circular sidebar portrait.
const palettes = [
  ['#F4E9E1', '#E7C7B7', '#B05B4E', '#793E42', '#F9DCAE'],
  ['#E4EEED', '#BAD6D2', '#398C86', '#246660', '#E9C286'],
  ['#ECE8F4', '#CFC3E9', '#7961AA', '#55457E', '#F2D0A9'],
  ['#E6EDF5', '#BED2E9', '#4C75A5', '#34557F', '#EDC98C'],
  ['#F5EEDC', '#EBD79B', '#AD8134', '#7A5C2E', '#D2E5D2'],
  ['#F3E6EC', '#E4BCCD', '#AC6184', '#784763', '#D7E3D0'],
] as const;
const skins = [
  ['#F5D1B5', '#DCAB8D', '#D99B90'], ['#E6B58F', '#C58C68', '#CF8D7F'],
  ['#C68E69', '#A46B4C', '#AD6B5F'], ['#A76F52', '#865039', '#914E48'],
  ['#81523F', '#603B31', '#A6655A'], ['#EAC3AC', '#C99C84', '#C88885'],
] as const;
const hairColors = ['#33313D', '#624336', '#996646', '#D5AD6C', '#6A6978', '#39575D'] as const;
const ink = '#293343';
type Shape = AvatarScene['shapes'][number];
const circle = (cx: number, cy: number, r: number, fill: string, extra = {}): Shape => ({type: 'circle', cx, cy, r, fill, ...extra});
const ellipse = (cx: number, cy: number, rx: number, ry: number, fill: string, extra = {}): Shape => ({type: 'ellipse', cx, cy, rx, ry, fill, ...extra});
const rect = (x: number, y: number, width: number, height: number, rx: number, fill: string, extra = {}): Shape => ({type: 'rect', x, y, width, height, rx, fill, ...extra});
const path = (d: string, fill: string, extra = {}): Shape => ({type: 'path', d, fill, ...extra});
const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, strokeWidth = 5): Shape => ({type: 'line', x1, y1, x2, y2, stroke, strokeWidth, linecap: 'round'});

/** Stable, credential-free default portrait. The seed is not rendered as text. */
export function defaultAvatarScene(seed: string): AvatarScene {
  if (typeof seed !== 'string' || seed.length > 4096) throw new Error('기본 이미지 seed를 확인하세요.');
  const hash = createHash('sha256').update('venditbot-default-avatar-v1\0').update(seed).digest();
  const [background, halo, coat, coatShadow, accent] = palettes[hash[0]! % palettes.length]!;
  const [skin, skinShadow, blush] = skins[hash[1]! % skins.length]!;
  const hair = hairColors[hash[2]! % hairColors.length]!, style = hash[3]! % 4, robot = hash[4]! % 4 === 0;
  const shapes: Shape[] = [
    circle(256, 247, 191, halo), circle(314, 153, 96, '#FFFFFF', {opacity: 0.2}),
    circle(112 + hash[8]! % 17, 143 + hash[9]! % 27, 4 + hash[10]! % 5, coat, {opacity: 0.3}), circle(388 + hash[11]! % 13, 272 + hash[12]! % 29, 4 + hash[13]! % 3, coat, {opacity: 0.35}),
    line(379, 141, 393, 141, '#FFFFFF', 4), line(386, 134, 386, 148, '#FFFFFF', 4),
    ellipse(258, 463, 144, 20, coatShadow, {opacity: 0.13}),
  ];
  // The lower silhouette deliberately continues below the circular crop.
  shapes.push(path('M 102 512 L 118 412 Q 130 360 218 346 L 294 346 Q 381 360 395 412 L 410 512 Z', coat));
  shapes.push(path('M 118 413 Q 139 380 167 376 L 159 512 L 102 512 Z', coatShadow, {opacity: 0.42}));
  shapes.push(path('M 346 374 Q 382 390 395 413 L 410 512 L 354 512 Z', coatShadow, {opacity: 0.35}));
  if (robot) {
    const antennaX = 232 + hash[14]! % 49, shell = ['#F5F3EC', '#E4ECE8', '#E5E8F0', '#F0E3E3', '#F1E8D6', '#DEDCEB'][hash[1]! % 6]!;
    shapes.push(rect(225, 300, 62, 70, 18, coatShadow), rect(234, 312, 44, 48, 12, accent));
    shapes.push(line(238, 328, 274, 328, coatShadow, 4), line(238, 341, 274, 341, coatShadow, 4));
    shapes.push(line(antennaX, 124, antennaX, 80, coatShadow, 8), circle(antennaX, 72, 15, coat), circle(antennaX - 5, 67, 5, '#FFFFFF', {opacity: 0.7}));
    shapes.push(rect(126, 200, 33, 67, 14, coatShadow), rect(353, 200, 33, 67, 14, coatShadow));
    shapes.push(rect(129, 207, 14, 39, 7, accent), rect(369, 207, 14, 39, 7, accent));
    shapes.push(rect(152, 119, 208, 207, 56, coatShadow), rect(158, 116, 196, 198, 53, shell));
    shapes.push(path('M 166 230 Q 168 295 207 301 L 310 301 Q 330 293 339 271 L 333 303 Q 320 318 299 318 L 214 318 Q 165 315 159 267 Z', halo));
    shapes.push(rect(176, 170, 160, 91, 32, ink), path('M 190 192 Q 205 178 230 182 L 311 182', 'none', {stroke: '#FFFFFF', strokeWidth: 5, opacity: 0.18, linecap: 'round'}));
    const eye = hash[5]! % 2 === 0;
    for (const x of [220, 292]) {
      shapes.push(eye ? rect(x - 9, 201, 18, 32, 9, accent) : path(`M ${x - 12} 221 Q ${x} 203 ${x + 12} 221`, 'none', {stroke: accent, strokeWidth: 8, linecap: 'round'}));
      shapes.push(circle(x + 2, 206, 3, '#FFFFFF', {opacity: eye ? 0.9 : 0}));
    }
    shapes.push(circle(183, 275, 7, coat, {opacity: 0.6}), circle(329, 275, 7, coat, {opacity: 0.6}));
    shapes.push(path('M 235 280 Q 256 295 277 280', 'none', {stroke: coatShadow, strokeWidth: 5, linecap: 'round'}));
    shapes.push(rect(190, 378, 132, 91, 21, coatShadow), rect(199, 383, 114, 73, 15, halo));
    shapes.push(circle(226, 409, 9, coat), line(247, 403, 288, 403, coat, 5), line(247, 416, 278, 416, coat, 5));
    shapes.push(line(216, 439, 296, 439, '#FFFFFF', 4), circle(349, 415, 7, accent));
  } else {
    // Long hair/bun stays behind the neck and face; the front fringe is separate.
    shapes.push(rect(151, 109, 210, style === 0 ? 254 : 204, 98, hair));
    if (style === 3) shapes.push(circle(295, 110, 47, hair), ellipse(287, 87, 20, 8, '#FFFFFF', {opacity: 0.1}));
    shapes.push(rect(225, 291, 62, 78, 25, skin), path('M 225 312 Q 256 338 287 313 L 287 330 Q 258 346 225 334 Z', skinShadow));
    shapes.push(path('M 219 343 L 256 369 L 232 408 L 204 361 Z', '#FCF8EE'), path('M 293 343 L 256 369 L 280 408 L 308 361 Z', '#EAE9E4'));
    shapes.push(line(256, 372, 256, 499, coatShadow, 3), circle(268, 423, 3, accent), circle(268, 456, 3, accent));
    shapes.push(ellipse(174, 233, 17, 24, skin), ellipse(338, 233, 17, 24, skin));
    shapes.push(path('M 172 226 Q 183 224 178 241', 'none', {stroke: skinShadow, strokeWidth: 4, linecap: 'round'}), path('M 340 226 Q 329 224 334 241', 'none', {stroke: skinShadow, strokeWidth: 4, linecap: 'round'}));
    shapes.push(rect(176, 133, 160, 192, 77, skin), path('M 181 219 Q 174 284 218 309 Q 259 337 298 311 Q 258 344 214 319 Q 177 296 176 245 Z', skinShadow, {opacity: 0.6}));
    shapes.push(ellipse(209, 267, 15, 8, blush, {opacity: 0.6}), ellipse(303, 267, 15, 8, blush, {opacity: 0.6}));
    const front = [
      'M 165 221 L 165 171 Q 170 108 252 112 Q 327 107 347 179 L 341 233 L 321 182 Q 275 180 236 145 Q 220 191 183 198 L 178 223 Z',
      'M 167 212 L 166 165 Q 170 114 237 111 Q 299 91 332 140 L 343 212 L 324 192 L 319 157 Q 266 186 217 154 Q 202 179 181 183 L 181 210 Z',
      'M 165 219 L 163 164 Q 167 122 201 116 Q 232 92 263 111 Q 303 96 329 127 Q 349 148 342 216 L 327 202 L 322 162 Q 306 183 279 162 Q 255 181 233 157 Q 211 177 190 165 L 181 211 Z',
      'M 164 223 L 163 168 Q 165 107 239 109 Q 314 92 343 167 L 341 217 L 326 207 L 321 155 Q 264 196 208 154 L 184 177 L 180 218 Z',
    ];
    shapes.push(path(front[style]!, hair), path('M 190 146 Q 210 125 237 125', 'none', {stroke: '#FFFFFF', strokeWidth: 5, opacity: 0.16, linecap: 'round'}));
    shapes.push(path('M 203 220 Q 215 214 227 219', 'none', {stroke: hair, strokeWidth: 5, linecap: 'round'}), path('M 285 219 Q 297 214 309 220', 'none', {stroke: hair, strokeWidth: 5, linecap: 'round'}));
    for (const x of [217, 295]) shapes.push(ellipse(x, 238, 6, 8, ink), circle(x + 2, 235, 2, '#FFFFFF'));
    shapes.push(path('M 255 241 L 250 264 Q 255 269 262 264', 'none', {stroke: skinShadow, strokeWidth: 4, linecap: 'round'}));
    shapes.push(path('M 236 284 Q 256 300 277 283', 'none', {stroke: '#804C47', strokeWidth: 5, linecap: 'round'}), path('M 246 305 Q 256 308 266 305', 'none', {stroke: skinShadow, strokeWidth: 3, opacity: 0.6, linecap: 'round'}));
    if (hash[6]! % 3 === 0) shapes.push(rect(194, 221, 47, 35, 13, 'none', {stroke: ink, strokeWidth: 5}), rect(271, 221, 47, 35, 13, 'none', {stroke: ink, strokeWidth: 5}), path('M 242 233 Q 256 226 270 233', 'none', {stroke: ink, strokeWidth: 4}), line(180, 230, 194, 233, ink, 4), line(318, 233, 332, 230, ink, 4));
    shapes.push(rect(302, 421, 40, 28, 6, accent), line(309, 431, 335, 431, coatShadow, 3), circle(170, 276, 4, accent));
  }
  return validateAvatarScene({background, shapes});
}

/** Each agent receives a new local default, without API calls or filesystem IO. */
export function randomDefaultAvatarScene(): AvatarScene {
  return defaultAvatarScene(randomBytes(32).toString('hex'));
}
