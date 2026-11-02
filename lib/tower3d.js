/**
 * lib/tower3d.js — the turnable tower. Returns null when three.js or WebGL is missing,
 * and the page then works from the floor list alone.
 */
export function initTower(container, floors, onPick) {
  const THREE = globalThis.THREE;
  if (!THREE) return null;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null;
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(4, 8, 6);
  scene.add(sun);

  const FH = 0.9;
  const tower = new THREE.Group();
  scene.add(tower);
  const base = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.2, 3.2), new THREE.MeshLambertMaterial({ color: 0x586070 }));
  base.position.y = -0.1;
  tower.add(base);

  const meshes = [];
  const windowMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
  floors.forEach((f, i) => {
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(f.color), emissive: new THREE.Color(0x000000) });
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, FH - 0.06, 2), mat);
    m.position.y = i * FH + FH / 2;
    m.userData.index = i;
    tower.add(m);
    meshes.push(m);
    for (const [x, z, ry] of [[0, 1.01, 0], [0, -1.01, Math.PI], [1.01, 0, Math.PI / 2], [-1.01, 0, -Math.PI / 2]]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.28), windowMat);
      w.position.set(x, m.position.y + 0.08, z);
      w.rotation.y = ry;
      tower.add(w);
    }
  });
  const top = floors.length * FH;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 2.2), new THREE.MeshLambertMaterial({ color: 0x586070 }));
  roof.position.y = top + 0.04;
  tower.add(roof);
  const open = new THREE.Mesh(new THREE.BoxGeometry(2, 0.05, 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }));
  open.position.y = top + 0.15;
  tower.add(open);

  const car = new THREE.Mesh(new THREE.BoxGeometry(0.34, FH - 0.2, 0.34), new THREE.MeshLambertMaterial({ color: 0x2b2f3a }));
  car.position.set(1.18, FH / 2, 1.18);
  tower.add(car);
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.08, top, 0.08), new THREE.MeshLambertMaterial({ color: 0x8a90a0 }));
  shaft.position.set(1.18, top / 2, 1.18);
  tower.add(shaft);

  camera.position.set(0, top * 0.62, 8.6);
  camera.lookAt(0, top * 0.5, 0);
  tower.rotation.y = -0.6;

  let target = FH / 2;
  let selectedIndex = -1;
  function select(i) {
    const first = selectedIndex < 0;
    selectedIndex = i;
    target = i * FH + FH / 2;
    if (first) car.position.y = target; // no ride on page load
    meshes.forEach((m, k) => m.material.emissive.setHex(k === i ? 0x333333 : 0x000000));
    if (reduced) car.position.y = target;
    draw();
  }

  function resize() {
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    draw();
  }
  function draw() { renderer.render(scene, camera); }

  let raf = 0;
  function tick() {
    raf = 0;
    const d = target - car.position.y;
    if (Math.abs(d) > 0.005) {
      car.position.y += d * 0.12;
      draw();
      raf = requestAnimationFrame(tick);
    } else if (car.position.y !== target) {
      car.position.y = target;
      draw();
    }
  }
  const kick = () => { if (!raf && !reduced) raf = requestAnimationFrame(tick); };

  // Drag turns the tower; a click without movement picks the floor under the pointer.
  const ray = new THREE.Raycaster();
  let down = null;
  const el = renderer.domElement;
  el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, moved: 0 }; el.setPointerCapture(e.pointerId); el.style.cursor = "grabbing"; });
  el.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    down.moved += Math.abs(dx) + Math.abs(e.clientY - down.y);
    down.x = e.clientX; down.y = e.clientY;
    tower.rotation.y += dx * 0.01;
    draw();
  });
  el.addEventListener("pointerup", (e) => {
    const was = down;
    down = null;
    el.style.cursor = "grab";
    if (!was || was.moved > 6) return;
    const r = el.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(meshes)[0];
    if (hit) onPick(hit.object.userData.index);
  });
  el.addEventListener("pointercancel", () => { down = null; el.style.cursor = "grab"; });

  new ResizeObserver(resize).observe(container);
  resize();
  const origSelect = select;
  return { select: (i) => { origSelect(i); kick(); }, get selectedIndex() { return selectedIndex; } };
}
