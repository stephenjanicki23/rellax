/**
 * 3D broadcast view of the live rink. Draws exactly what the 2D rink draws
 * (the same RinkMotion bodies and puck, which follow the engine's positions)
 * as a lit arena: ice with its markings, boards and glass, nets, a crowd,
 * and skaters in their team's colours with a ring under each one.
 *
 * Rink coordinates are feet (x 0..200 along the ice, y 0..85 across); in the
 * scene x runs the same way, z = y - 42.5 and y is up.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RINK, attackDir, type RinkPlayer } from './director';
import type { RinkMotion } from './motion';

export type Cam3D = 'behind' | 'broadcast';

interface Rink3DProps {
  motion: RinkMotion;
  meta: Map<number, RinkPlayer>;
  /** [primary, secondary] colours, home then away. */
  colors: readonly [readonly [string, string], readonly [string, string]];
  abbr: [string, string];
  score: [number, number];
  period: number;
  /** Goal light on behind the net this team scored on. */
  light: 0 | 1 | null;
  onFail: () => void;
}

const W = RINK.w;
const H = RINK.h;
const CORNER = 28;
/** Players are drawn a little larger than life so numbers read from the broadcast camera. */
const SCALE = 1.35;

const toScene = (x: number, y: number) => new THREE.Vector3(x - RINK.cx, 0, y - RINK.cy);

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x0 = -w / 2;
  const y0 = -h / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0);
  s.absarc(x0 + w - r, y0 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x0 + w, y0 + h - r);
  s.absarc(x0 + w - r, y0 + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x0 + r, y0 + h);
  s.absarc(x0 + r, y0 + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x0, y0 + r);
  s.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** A band around the rink outline (inner offset a, outer offset b), extruded upward from y0 by height h. */
function band(a: number, b: number, h: number, y0: number, mat: THREE.Material): THREE.Mesh {
  const outer = roundedRect(W + 2 * b, H + 2 * b, CORNER + b);
  const inner = roundedRect(W + 2 * a, H + 2 * a, CORNER + a);
  outer.holes.push(new THREE.Path(inner.getPoints(48)));
  const g = new THREE.ExtrudeGeometry(outer, { depth: h, bevelEnabled: false, curveSegments: 24 });
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.y = y0;
  return m;
}

/** The ice: white sheet with the real markings, painted once on a canvas. */
function iceTexture(homeAbbr: string, homeColor: string): THREE.CanvasTexture {
  const PX = 10;
  const c = document.createElement('canvas');
  c.width = W * PX;
  c.height = H * PX;
  const g = c.getContext('2d')!;
  g.scale(PX, PX);
  g.fillStyle = '#f4f8fb';
  g.fillRect(0, 0, W, H);
  // Faint skate scratches and snow.
  for (let i = 0; i < 1400; i++) {
    g.strokeStyle = `rgba(160,180,200,${0.04 + Math.random() * 0.06})`;
    g.lineWidth = 0.05 + Math.random() * 0.08;
    const x = Math.random() * W;
    const y = Math.random() * H;
    const a = Math.random() * Math.PI;
    const l = 1 + Math.random() * 6;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  const RED = '#c8102e';
  const BLUE = '#1f4fa8';
  // Centre line, blue lines, goal lines.
  g.fillStyle = RED;
  g.fillRect(RINK.cx - 0.5, 0, 1, H);
  g.fillStyle = BLUE;
  g.fillRect(RINK.cx - 25 - 0.5, 0, 1, H);
  g.fillRect(RINK.cx + 25 - 0.5, 0, 1, H);
  g.fillStyle = RED;
  g.fillRect(RINK.goalL - 0.08, 0, 0.17, H);
  g.fillRect(RINK.goalR - 0.08, 0, 0.17, H);
  // Centre circle and logo.
  g.strokeStyle = BLUE;
  g.lineWidth = 0.17;
  g.beginPath();
  g.arc(RINK.cx, RINK.cy, 15, 0, Math.PI * 2);
  g.stroke();
  g.save();
  g.globalAlpha = 0.85;
  g.fillStyle = homeColor;
  g.beginPath();
  g.arc(RINK.cx, RINK.cy, 9, 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 1;
  g.fillStyle = '#fff';
  g.font = '800 6px "Barlow Condensed", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(homeAbbr, RINK.cx, RINK.cy + 0.3);
  g.restore();
  // Faceoff circles and dots.
  g.strokeStyle = RED;
  g.fillStyle = RED;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const x = RINK.cx + sx * 69;
      const y = RINK.cy + sy * 22;
      g.lineWidth = 0.17;
      g.beginPath();
      g.arc(x, y, 15, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(x, y, 1, 0, Math.PI * 2);
      g.fill();
      // Hash marks.
      for (const hy of [-1, 1]) for (const hx of [-1, 1]) g.fillRect(x + hx * 2.9 - 0.08, y + hy * 15, 0.17, hy * 2);
      g.beginPath();
      g.arc(RINK.cx + sx * 20, y, 1, 0, Math.PI * 2);
      g.fill();
    }
  // Creases.
  for (const [gx, d] of [
    [RINK.goalL, 1],
    [RINK.goalR, -1],
  ] as const) {
    g.fillStyle = 'rgba(90,163,224,0.7)';
    g.beginPath();
    g.moveTo(gx, RINK.cy - 4);
    g.lineTo(gx + d * 4.5, RINK.cy - 4);
    g.arc(gx + d * 4.5, RINK.cy, 4, -Math.PI / 2, Math.PI / 2, d < 0);
    g.lineTo(gx, RINK.cy + 4);
    g.closePath();
    g.fill();
    g.strokeStyle = RED;
    g.lineWidth = 0.17;
    g.stroke();
  }
  // Outside the rounded boards is transparent.
  g.globalCompositeOperation = 'destination-in';
  g.beginPath();
  g.roundRect(0, 0, W, H, CORNER);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function textOn(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.62 ? '#111111' : '#ffffff';
}

/** Jersey panel with the number on it (back and chest). */
function numberTexture(num: number | null, jersey: string, trim: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = jersey;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = trim;
  g.fillRect(0, 92, 128, 12);
  if (num !== null) {
    g.font = '800 72px "Barlow Condensed", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = trim;
    g.strokeText(String(num), 64, 50);
    g.fillStyle = textOn(jersey);
    g.fillText(String(num), 64, 50);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Skater {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  ring: THREE.Mesh;
  ring2: THREE.Mesh;
  phase: number;
  goalie: boolean;
  team: 0 | 1;
}

const box = (w: number, h: number, d: number, mat: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};

/** A blocky skater (or goalie) facing +x, feet at the origin. */
function buildSkater(p: RinkPlayer | undefined, team: 0 | 1, goalie: boolean, colors: readonly [string, string]): Skater {
  const [jersey, trim] = colors;
  const ringCol = jersey === '#f4f4f2' ? trim : jersey;
  const jm = new THREE.MeshStandardMaterial({ color: jersey, roughness: 0.7 });
  const tm = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.7 });
  const pants = new THREE.MeshStandardMaterial({ color: lum(jersey) > 0.62 ? trim : '#15181d', roughness: 0.8 });
  const black = new THREE.MeshStandardMaterial({ color: '#0d0f12', roughness: 0.5 });
  const steel = new THREE.MeshStandardMaterial({ color: '#cfd6de', metalness: 0.8, roughness: 0.3 });
  const white = new THREE.MeshStandardMaterial({ color: '#f2f2ee', roughness: 0.6 });
  const num = numberTexture(p?.number ?? null, jersey, trim);
  const numMat = new THREE.MeshStandardMaterial({ map: num, roughness: 0.7 });

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const legL = new THREE.Group();
  const legR = new THREE.Group();
  const hipY = goalie ? 2.4 : 2.7;
  for (const [leg, z] of [
    [legL, -0.42],
    [legR, 0.42],
  ] as const) {
    leg.position.set(0, hipY, z);
    if (goalie) {
      leg.add(box(0.85, hipY, 0.9, white, 0.15, -hipY / 2, 0));
      leg.add(box(1.2, 0.25, 0.5, black, 0.25, -hipY + 0.1, 0));
    } else {
      leg.add(box(0.55, hipY - 0.35, 0.55, pants, 0, -(hipY - 0.35) / 2, 0));
      leg.add(box(1.15, 0.35, 0.42, black, 0.2, -hipY + 0.28, 0));
      leg.add(box(1.25, 0.08, 0.06, steel, 0.2, -hipY + 0.04, 0));
    }
    body.add(leg);
  }
  // Torso: number on the back (-x) and chest (+x).
  const tw = goalie ? 1.5 : 1.2;
  const td = goalie ? 2.2 : 1.75;
  const torso = box(tw, 2.1, td, [numMat, numMat, jm, jm, jm, jm], 0, hipY + 1.05, 0);
  body.add(torso);
  body.add(box(tw + 0.05, 0.25, td + 0.05, tm, 0, hipY + 0.2, 0));
  // Shoulders and arms.
  body.add(box(tw * 0.9, 0.5, td + 0.5, jm, 0, hipY + 1.95, 0));
  body.add(box(0.5, 1.5, 0.45, jm, 0.35, hipY + 1.05, -(td / 2 + 0.3)));
  body.add(box(0.5, 1.5, 0.45, jm, 0.35, hipY + 1.05, td / 2 + 0.3));
  body.add(box(0.5, 0.45, 0.5, black, 0.55, hipY + 0.25, -(td / 2 + 0.3)));
  body.add(box(0.5, 0.45, 0.5, black, 0.55, hipY + 0.25, td / 2 + 0.3));
  // Helmet (goalies: a white mask).
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 12), goalie ? white : new THREE.MeshStandardMaterial({ color: lum(jersey) > 0.62 ? trim : jersey, roughness: 0.35, metalness: 0.1 }));
  head.position.set(0, hipY + 2.75, 0);
  head.castShadow = true;
  body.add(head);
  const visor = box(0.15, 0.3, 0.9, new THREE.MeshStandardMaterial({ color: '#223', roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.8 }), 0.55, hipY + 2.72, 0);
  body.add(visor);
  // Stick: from the hands down to a blade on the ice ahead and to the right.
  const stick = new THREE.Group();
  stick.position.set(0.6, hipY + 0.25, td / 2 + 0.3);
  const shaft = box(0.12, 4.6, 0.12, black, 0, -2.3, 0);
  stick.add(shaft);
  stick.add(box(1.0, 0.3, 0.08, white, 0.4, -4.55, 0));
  stick.rotation.z = goalie ? -0.35 : -0.8;
  stick.rotation.x = 0.25;
  body.add(stick);
  if (goalie) {
    body.add(box(0.4, 1.1, 0.9, white, 0.6, hipY + 0.9, -(td / 2 + 0.55)));
    const glove = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.35, 14), white);
    glove.rotation.z = Math.PI / 2;
    glove.position.set(0.6, hipY + 1.2, td / 2 + 0.6);
    body.add(glove);
  }
  body.scale.setScalar(SCALE);

  // Rings on the ice (team colour; gold when he has the puck).
  const ringMat = new THREE.MeshBasicMaterial({ color: ringCol, transparent: true, opacity: 0.9, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.7, 40), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  root.add(ring);
  const ring2 = new THREE.Mesh(new THREE.RingGeometry(3.1, 3.35, 40), new THREE.MeshBasicMaterial({ color: ringCol, transparent: true, opacity: 0.45, depthWrite: false }));
  ring2.rotation.x = -Math.PI / 2;
  ring2.position.y = 0.035;
  root.add(ring2);
  return { root, body, legL, legR, ring, ring2, phase: Math.random() * 6, goalie, team };
}

function lum(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function buildNet(gx: number, d: 1 | -1): THREE.Group {
  const net = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: '#d0102a', roughness: 0.4, metalness: 0.3 });
  const post = (x: number, y: number, z: number, len: number, axis: 'x' | 'y' | 'z') => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, len, 10), red);
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    m.castShadow = true;
    net.add(m);
  };
  post(0, 2, -3, 4, 'y');
  post(0, 2, 3, 4, 'y');
  post(0, 4, 0, 6, 'z');
  post(-d * 1.7, 0.1, -3, 3.4, 'x');
  post(-d * 1.7, 0.1, 3, 3.4, 'x');
  post(-d * 3.4, 0.1, 0, 6, 'z');
  const mesh = new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.38, side: THREE.DoubleSide, wireframe: false });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), mesh);
  back.rotation.y = Math.PI / 2;
  back.position.set(-d * 2.6, 2, 0);
  back.rotation.z = 0;
  back.rotation.x = 0;
  back.rotateX(d * 0.35);
  net.add(back);
  for (const z of [-3, 3]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 4), mesh);
    side.position.set(-d * 1.7, 2, z);
    net.add(side);
  }
  const top = new THREE.Mesh(new THREE.PlaneGeometry(2, 6), mesh);
  top.rotation.x = -Math.PI / 2;
  top.rotation.z = Math.PI / 2;
  top.position.set(-d * 1, 3.95, 0);
  net.add(top);
  const p = toScene(gx, RINK.cy);
  net.position.set(p.x, 0, p.z);
  return net;
}

/** The crowd: rows of seated fans (instanced boxes) on tiers rising away from the glass. */
function buildCrowd(home: string, away: string): THREE.Group {
  const g = new THREE.Group();
  const tierMat = new THREE.MeshStandardMaterial({ color: '#1b2029', roughness: 0.9 });
  const rows = 9;
  const perRow: THREE.Vector2[][] = [];
  for (let k = 0; k < rows; k++) {
    const off = 9 + k * 3;
    const y = 3.8 + k * 2.1;
    g.add(band(off - 1.5, off + 1.5, 0.6, y - 0.6, tierMat));
    const outline = roundedRect(W + 2 * off, H + 2 * off, CORNER + off);
    const len = outline.getLength();
    perRow.push(outline.getSpacedPoints(Math.floor(len / 1.5)));
  }
  const count = perRow.reduce((s, r) => s + r.length, 0);
  const fan = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 1.7, 0.9), new THREE.MeshStandardMaterial({ roughness: 0.9 }), count);
  const palette = [home, home, home, '#e9e9e9', '#2b2f36', '#53606e', away, '#8a1c1c', '#c9b27a'].map((c) => new THREE.Color(c));
  const m = new THREE.Matrix4();
  let i = 0;
  perRow.forEach((pts, k) => {
    const y = 3.8 + k * 2.1 + 0.85;
    for (const p of pts) {
      if (Math.random() < 0.08) continue;
      m.makeTranslation(p.x + (Math.random() - 0.5) * 0.4, y, -p.y);
      fan.setMatrixAt(i, m);
      const c = palette[Math.floor(Math.random() * palette.length)].clone().offsetHSL(0, 0, (Math.random() - 0.5) * 0.12);
      fan.setColorAt(i, c);
      i++;
    }
  });
  fan.count = i;
  fan.instanceMatrix.needsUpdate = true;
  if (fan.instanceColor) fan.instanceColor.needsUpdate = true;
  g.add(fan);
  return g;
}

function scoreboardTexture(abbr: [string, string], score: [number, number], colors: Rink3DProps['colors']): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#05070b';
  g.fillRect(0, 0, 512, 256);
  for (const [i, x] of [0, 256].entries()) {
    g.fillStyle = colors[i][0];
    g.fillRect(x + 12, 12, 232, 56);
    g.fillStyle = textOn(colors[i][0]);
    g.font = '800 44px "Barlow Condensed", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(abbr[i], x + 128, 42);
    g.fillStyle = '#ffd34d';
    g.font = '800 140px "Barlow Condensed", system-ui, sans-serif';
    g.fillText(String(score[i]), x + 128, 170);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export default function Rink3D({ motion, meta, colors, abbr, score, period, light, onFail }: Rink3DProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const [cam, setCam] = useState<Cam3D>(() => {
    try {
      return (localStorage.getItem('hgm.cam3d') as Cam3D) || 'behind';
    } catch {
      return 'behind';
    }
  });
  const live = useRef({ cam, score, period, light });
  live.current = { cam, score, period, light };

  useEffect(() => {
    try {
      localStorage.setItem('hgm.cam3d', cam);
    } catch {
      /* per-viewer convenience only */
    }
  }, [cam]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      onFail();
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0f16');
    scene.fog = new THREE.Fog('#0b0f16', 160, 330);
    const camera = new THREE.PerspectiveCamera(42, 16 / 9, 1, 800);

    // Lights: arena rigs overhead.
    scene.add(new THREE.HemisphereLight('#ffffff', '#3a4a5c', 1.1));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(-40, 140, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -115;
    sc.right = 115;
    sc.top = 60;
    sc.bottom = -60;
    sc.near = 20;
    sc.far = 320;
    sun.shadow.bias = -0.0005;
    scene.add(sun);

    // Ice.
    const iceTex = iceTexture(abbr[0], colors[0][0]);
    const ice = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: iceTex, transparent: true, alphaTest: 0.5, roughness: 0.18, metalness: 0.05 }));
    ice.rotation.x = -Math.PI / 2;
    ice.receiveShadow = true;
    scene.add(ice);
    // Concourse floor beyond the boards.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 400), new THREE.MeshStandardMaterial({ color: '#11161e', roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.05;
    scene.add(floor);
    // Boards: white with a yellow kickplate and a team-coloured cap; glass above.
    scene.add(band(0, 0.7, 3.4, 0, new THREE.MeshStandardMaterial({ color: '#f3f5f7', roughness: 0.5 })));
    scene.add(band(-0.02, 0.72, 0.7, 0, new THREE.MeshStandardMaterial({ color: '#e8b923', roughness: 0.6 })));
    scene.add(band(-0.05, 0.9, 0.3, 3.4, new THREE.MeshStandardMaterial({ color: colors[0][0], roughness: 0.4 })));
    scene.add(band(0.3, 0.45, 6, 3.7, new THREE.MeshPhysicalMaterial({ color: '#cfe8ff', transparent: true, opacity: 0.12, roughness: 0.05, depthWrite: false })));
    scene.add(buildNet(RINK.goalL, 1));
    scene.add(buildNet(RINK.goalR, -1));
    scene.add(buildCrowd(colors[0][0], colors[1][0]));

    // Hanging scoreboard over centre ice.
    const boardMat = new THREE.MeshBasicMaterial({ map: scoreboardTexture(abbr, live.current.score, colors) });
    const jumbo = new THREE.Mesh(new THREE.BoxGeometry(22, 11, 22), [boardMat, boardMat, new THREE.MeshStandardMaterial({ color: '#111' }), new THREE.MeshStandardMaterial({ color: '#111' }), boardMat, boardMat]);
    jumbo.position.set(0, 62, 0);
    scene.add(jumbo);
    let shownScore = live.current.score.join('-');

    // Goal lights behind each net.
    const lamps = [RINK.goalL, RINK.goalR].map((gx) => {
      const l = new THREE.PointLight('#ff2a2a', 0, 40, 1.5);
      const p = toScene(gx, RINK.cy);
      l.position.set(p.x + (gx < RINK.cx ? -6 : 6), 9, 0);
      scene.add(l);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 8), new THREE.MeshBasicMaterial({ color: '#550000' }));
      bulb.position.copy(l.position);
      scene.add(bulb);
      return { l, bulb, gx };
    });

    // Puck and its trail.
    const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.18, 20), new THREE.MeshStandardMaterial({ color: '#050505', roughness: 0.4 }));
    puck.castShadow = true;
    scene.add(puck);
    const trailGeo = new THREE.BufferGeometry();
    const trailPts = new Float32Array(10 * 3);
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPts, 3));
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.0 }));
    scene.add(trail);
    const trailHist: THREE.Vector3[] = [];

    const skaters = new Map<number, Skater>();
    const gold = new THREE.Color('#f2c94c');
    const teamCol = [new THREE.Color(colors[0][0]), new THREE.Color(colors[1][0])];
    const camPos = new THREE.Vector3(0, 60, 90);
    const camLook = new THREE.Vector3();
    let firstFrame = true;

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    let last = performance.now();
    let prevP = motion.P;
    const prevPuck = new THREE.Vector3();
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const L = live.current;
      // Players come and go with line changes.
      for (const [id, s] of skaters)
        if (!motion.bodies.has(id)) {
          scene.remove(s.root);
          skaters.delete(id);
        }
      const pm = motion.puck.mode;
      const carrier = pm.kind === 'carried' ? pm.carrier : null;
      const t = now / 1000;
      for (const [id, b] of motion.bodies) {
        let s = skaters.get(id);
        if (!s) {
          const m = meta.get(id);
          const team = (m?.team ?? b.team) as 0 | 1;
          // Home in their colours, visitors in white with their colour as trim (as on TV).
          s = buildSkater(m, team, b.goalie, team === 0 ? colors[0] : ['#f4f4f2', colors[1][0]]);
          skaters.set(id, s);
          scene.add(s.root);
        }
        const p = toScene(b.pos.x, b.pos.y);
        s.root.position.set(p.x, 0, p.z);
        s.body.rotation.y = -b.face;
        const sp = Math.hypot(b.vel.x, b.vel.y);
        if (!s.goalie) {
          s.phase += dt * (2 + sp * 0.32);
          const amp = Math.min(0.75, sp / 28);
          s.legL.rotation.z = Math.sin(s.phase) * amp;
          s.legR.rotation.z = -Math.sin(s.phase) * amp;
          s.body.rotation.z = -Math.min(0.32, sp / 70);
          s.body.position.y = Math.abs(Math.sin(s.phase)) * amp * 0.12;
        } else {
          // Butterfly when a shot is on its way.
          const down = pm.kind === 'flying' && pm.shot && Math.hypot(pm.to.x - b.pos.x, pm.to.y - b.pos.y) < 9;
          const target = down ? 0.65 : 1;
          s.body.scale.y += (target * SCALE - s.body.scale.y) * Math.min(1, dt * 12);
        }
        const has = id === carrier;
        const rm = s.ring.material as THREE.MeshBasicMaterial;
        rm.color.copy(has ? gold : teamCol[s.team]);
        const pulse = has ? 1 + Math.sin(t * 7) * 0.08 : 1;
        s.ring.scale.setScalar(pulse * (has ? 1.12 : 1));
        (s.ring2.material as THREE.MeshBasicMaterial).color.copy(has ? gold : teamCol[s.team]);
        (s.ring2.material as THREE.MeshBasicMaterial).opacity = has ? 0.75 : 0.35;
      }

      // Puck: on the ice, lifted on shots.
      const pk = motion.puck.pos;
      const pp = toScene(pk.x, pk.y);
      let py = 0.12;
      if (pm.kind === 'flying' && pm.shot) {
        const f = Math.min(1, Math.max(0, (motion.P - pm.t0) / Math.max(0.05, pm.t1 - pm.t0)));
        py += Math.sin(Math.PI * f) * 2.2;
      }
      puck.position.set(pp.x, py, pp.z);
      const dP = motion.P - prevP;
      prevP = motion.P;
      const speed = dP > 0 ? puck.position.distanceTo(prevPuck) / dP : 0;
      prevPuck.copy(puck.position);
      if (speed > 40 && pm.kind !== 'carried') trailHist.push(puck.position.clone());
      else trailHist.splice(0, Math.max(1, Math.ceil(trailHist.length / 3)));
      if (trailHist.length > 10) trailHist.splice(0, trailHist.length - 10);
      for (let i = 0; i < 10; i++) {
        const v = trailHist[Math.min(i, trailHist.length - 1)] ?? puck.position;
        trailPts[i * 3] = v.x;
        trailPts[i * 3 + 1] = v.y;
        trailPts[i * 3 + 2] = v.z;
      }
      trailGeo.attributes.position.needsUpdate = true;
      (trail.material as THREE.LineBasicMaterial).opacity = trailHist.length > 1 ? 0.7 : 0;

      // Goal lights.
      for (const lp of lamps) {
        const on = L.light !== null && (attackDir(L.light, L.period) > 0 ? lp.gx > RINK.cx : lp.gx < RINK.cx);
        const k = on ? 0.6 + 0.4 * Math.abs(Math.sin(t * 7)) : 0;
        lp.l.intensity = k * 900;
        (lp.bulb.material as THREE.MeshBasicMaterial).color.set(on ? '#ff3030' : '#550000');
      }
      const sk = L.score.join('-');
      if (sk !== shownScore) {
        shownScore = sk;
        boardMat.map?.dispose();
        boardMat.map = scoreboardTexture(abbr, L.score, colors);
        boardMat.needsUpdate = true;
      }

      // Camera: follows the puck, smoothed so it glides rather than jerks.
      const fx = THREE.MathUtils.clamp(pp.x, -78, 78);
      const fz = THREE.MathUtils.clamp(pp.z, -30, 30);
      const want = new THREE.Vector3();
      const look = new THREE.Vector3();
      if (L.cam === 'broadcast') {
        want.set(fx, 60, 42.5 + 56);
        look.set(fx, 0, fz * 0.4 - 4);
      } else {
        // Behind the home team, looking the way it attacks this period (like a football end-zone camera).
        const d = attackDir(0, L.period);
        const bx = THREE.MathUtils.clamp(pp.x, -70, 70);
        // Narrow screens (phones) need the camera further back to fit the play.
        const back = camera.aspect < 1.5 ? 1.3 : 1;
        want.set(bx - d * 42 * back, 24 * back, fz * 0.6);
        look.set(bx + d * 10, 0, fz * 0.85);
      }
      const k = firstFrame ? 1 : 1 - Math.exp(-dt * 2.2);
      firstFrame = false;
      camPos.lerp(want, k);
      camLook.lerp(look, k);
      camera.position.copy(camPos);
      camera.lookAt(camLook);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          (x as THREE.MeshStandardMaterial).map?.dispose();
          x.dispose();
        }
      });
      el.removeChild(renderer.domElement);
    };
    // The scene is built once per game; live values come through `live`.
  }, [motion, meta, colors, abbr, onFail]);

  return (
    <div className="rink3d" ref={host}>
      <div className="rink3d-cams">
        <button className={`rink-toggle ${cam === 'behind' ? 'on' : ''}`} onClick={() => setCam('behind')} title="Camera behind the play, looking down the ice">
          Behind
        </button>
        <button className={`rink-toggle ${cam === 'broadcast' ? 'on' : ''}`} onClick={() => setCam('broadcast')} title="TV camera from the side">
          Broadcast
        </button>
      </div>
    </div>
  );
}
