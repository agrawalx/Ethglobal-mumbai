import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { BRAND } from "../config/brand";

type Props = {
  onPhase?: (phase: "cube" | "tree") => void;
};

const MOTION = {
  cycleSeconds: 5.2,
  toTreeStart: 1.5,
  toTreeEnd: 2.2,
  toCubeStart: 4.1,
  toCubeEnd: 4.8,
  idleSpin: 0.78,
};
const vertexShader = `
attribute vec3 aTree; attribute float aSeed;
uniform float uTime,uMorph,uPixelRatio,uSize,uActive,uReflection;
uniform vec2 uPointer; varying float vSeed;
void main(){
 vec3 p=mix(position,aTree,uMorph);
 float scatter=sin(uMorph*3.14159265);
 vec3 drift=vec3(sin(aSeed*72.0+uTime*.45),cos(aSeed*91.0+uTime*.3),sin(aSeed*37.0-uTime*.3));
 p+=drift*(scatter*(.2+aSeed*.5)+.013);
 if(uReflection>.5)p.y=-3.70-p.y;
 vec4 mv=modelViewMatrix*vec4(p,1.0);vec4 projected=projectionMatrix*mv;
 vec2 delta=projected.xy/projected.w-uPointer;
 projected.xy+=normalize(delta+vec2(.0001))*exp(-dot(delta,delta)*26.0)*.13*uActive*projected.w;
 gl_Position=projected;
 gl_PointSize=clamp(uSize*uPixelRatio*(7.0/-mv.z)*(.45+aSeed*.9),.6,5.5);vSeed=aSeed;
}`;
const fragmentShader = `
uniform float uOpacity,uEdge;varying float vSeed;
void main(){float r=length(gl_PointCoord-vec2(.5));if(r>.5)discard;
 vec3 color=mix(vec3(.025,.20,1.0),vec3(.06,.45,1.0),smoothstep(.3,1.0,vSeed));
 color=mix(color,vec3(.46,.10,1.0),step(.91,vSeed)*.7);
 color=mix(color,vec3(.3,.72,1.0),uEdge);
 gl_FragColor=vec4(color*(.75+vSeed*.65),pow(1.0-r*2.0,1.15)*uOpacity);
}`;
function randomGenerator(seed = 5149) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
type Branch = { from: THREE.Vector3; to: THREE.Vector3; thickness: number };
function makeParticleGeometry(count: number, edgesOnly = false) {
  const random = randomGenerator(edgesOnly ? 719 : 5149),
    cube = new Float32Array(count * 3),
    tree = new Float32Array(count * 3),
    seeds = new Float32Array(count);
  const branches: Branch[] = [],
    tips: THREE.Vector3[] = [];
  const grow = (
    from: THREE.Vector3,
    angle: number,
    length: number,
    depth: number,
  ) => {
    const to = from
      .clone()
      .add(
        new THREE.Vector3(
          Math.cos(angle) * length,
          length * (0.42 + random() * 0.28),
          Math.sin(angle) * length * 0.72,
        ),
      );
    branches.push({ from, to, thickness: (0.055 * (depth + 1)) / 4 });
    if (depth > 0) {
      grow(to, angle - 0.56 - random() * 0.2, length * 0.57, depth - 1);
      grow(to, angle + 0.56 + random() * 0.2, length * 0.57, depth - 1);
    } else tips.push(to);
  };
  for (let i = 0; i < 7; i++)
    grow(new THREE.Vector3(0, -0.28, 0), (i / 7) * Math.PI * 2 + 0.2, 1.13, 3);
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    seeds[i] = random();
    let x = (random() - 0.5) * 2.65,
      y = (random() - 0.5) * 2.65,
      z = (random() - 0.5) * 2.65;
    if (edgesOnly) {
      const axis = i % 3,
        a = (Math.floor(i / 3) % 2 ? 1 : -1) * 1.325,
        b = (Math.floor(i / 6) % 2 ? 1 : -1) * 1.325;
      if (axis === 0) {
        y = a;
        z = b;
      } else if (axis === 1) {
        x = a;
        z = b;
      } else {
        x = a;
        y = b;
      }
    } else {
      const face = Math.floor(random() * 6);
      if (random() > 0.19) {
        if (face < 2) x = (face ? 1 : -1) * 1.325;
        else if (face < 4) y = (face === 3 ? 1 : -1) * 1.325;
        else z = (face === 5 ? 1 : -1) * 1.325;
      }
    }
    cube.set([x, y, z], k);
    const part = random();
    if (part < 0.15) {
      const t = random(),
        theta = random() * Math.PI * 2 + t * 3,
        radius = Math.sqrt(random()) * (0.11 + 0.075 * (1 - t));
      tree.set(
        [
          Math.cos(theta) * radius + Math.sin(t * 5) * 0.045,
          -1.82 + t * 1.65,
          Math.sin(theta) * radius,
        ],
        k,
      );
    } else if (part < 0.39) {
      const b = branches[Math.floor(random() * branches.length)],
        p = b.from.clone().lerp(b.to, random());
      p.add(
        new THREE.Vector3(
          (random() - 0.5) * b.thickness,
          (random() - 0.5) * b.thickness,
          (random() - 0.5) * b.thickness,
        ),
      );
      tree.set(p.toArray(), k);
    } else {
      const tip = tips[Math.floor(random() * tips.length)],
        theta = random() * Math.PI * 2,
        phi = Math.acos(2 * random() - 1),
        r = Math.cbrt(random());
      tree.set(
        [
          tip.x + Math.cos(theta) * Math.sin(phi) * r * 0.48,
          tip.y + Math.cos(phi) * r * 0.37,
          tip.z + Math.sin(theta) * Math.sin(phi) * r * 0.42,
        ],
        k,
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(cube, 3));
  geometry.setAttribute("aTree", new THREE.BufferAttribute(tree, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  return geometry;
}
export default function ParticleScene({ onPhase }: Props) {
  const container = useRef<HTMLDivElement>(null),
    options = useRef({ onPhase });
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    options.current = { onPhase };
  }, [onPhase]);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const mobile = window.innerWidth < 700,
      reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        powerPreference: "low-power",
      });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, mobile ? 1.4 : 1.75),
    );
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(39, 1, 0.1, 90);
    camera.position.set(0, 1.05, 9.3);
    camera.lookAt(0, -0.06, 0);
    const group = new THREE.Group();
    group.rotation.set(0.06, 0.58, 0.025);
    scene.add(group);
    const pointer = new THREE.Vector2(10, 10);
    const uniforms = {
      uTime: { value: 0 },
      uMorph: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uPointer: { value: pointer },
      uActive: { value: 0 },
      uSize: { value: 2.65 },
      uOpacity: { value: 1.16 },
      uEdge: { value: 0 },
      uReflection: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const geometry = makeParticleGeometry(mobile ? 14000 : 28000);
    group.add(new THREE.Points(geometry, material));
    const edgeGeometry = makeParticleGeometry(4200, true),
      edgeMaterial = material.clone();
    edgeMaterial.uniforms.uPointer = uniforms.uPointer;
    edgeMaterial.uniforms.uSize.value = 2.85;
    edgeMaterial.uniforms.uOpacity.value = 2.2;
    edgeMaterial.uniforms.uEdge.value = 1;
    group.add(new THREE.Points(edgeGeometry, edgeMaterial));
    const reflectionMaterial = material.clone();
    reflectionMaterial.uniforms.uReflection.value = 1;
    reflectionMaterial.uniforms.uOpacity.value = 0.13;
    reflectionMaterial.uniforms.uSize.value = 1.2;
    group.add(new THREE.Points(geometry, reflectionMaterial));
    const floorMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec2 vPosition;
        uniform float uTime;
        void main() {
          vec3 p = position;
          vPosition = p.xy;
          float r = length(p.xy);
          float angle = atan(p.y, p.x) - uTime * .38;
          float ripple = r * 6.4 - uTime * 1.35
            + sin(angle * 3.0 + r * .65) * .38;
          p.z = sin(ripple) * .03;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vPosition;
        uniform float uTime;
        void main() {
          float r = length(vPosition);
          float angle = atan(vPosition.y, vPosition.x) - uTime * .38;
          float ripple = r * 6.4 - uTime * 1.35
            + sin(angle * 3.0 + r * .65) * .38;
          float wave = pow(max(0.0, cos(ripple)), 20.0);
          float spiral = pow(max(0.0, cos(angle * 3.0 - r * 2.8)), 28.0);
          float fade = exp(-r * .25) * smoothstep(.18, .75, r);
          vec3 color = mix(vec3(.055, .2, .8), vec3(.09, .4, .95), wave);
          gl_FragColor = vec4(color, (wave * .43 + spiral * .15) * fade);
        }
      `,
    });
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(35, 35, 100, 100),
      floorMaterial,
    );
    floor.name = "spiral-pool";
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.85;
    scene.add(floor);
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#e3f8ff";
    ctx.shadowColor = "#3cbaff";
    ctx.shadowBlur = 10;
    // Cube-face label: chip glyph + brand short name (was quil's feather + "Quil").
    ctx.font = "500 84px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(BRAND.short, 405, 137);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#d8f5ff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeRect(108, 100, 74, 74);
    ctx.strokeRect(132, 124, 26, 26);
    ctx.beginPath();
    for (const o of [126, 164]) {
      ctx.moveTo(o, 100); ctx.lineTo(o, 82);
      ctx.moveTo(o, 174); ctx.lineTo(o, 192);
      ctx.moveTo(108, o - 26 + 24); ctx.lineTo(90, o - 26 + 24);
      ctx.moveTo(182, o - 26 + 24); ctx.lineTo(200, o - 26 + 24);
    }
    ctx.stroke();
    const texture = new THREE.CanvasTexture(canvas),
      labelMaterial = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      label = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.76), labelMaterial);
    label.position.set(0, -0.18, 1.34);
    group.add(label);
    const random = randomGenerator(422),
      starPositions = new Float32Array(1800 * 3);
    for (let i = 0; i < 1800; i++)
      starPositions.set(
        [(random() - 0.5) * 48, (random() - 0.5) * 29, -4 - random() * 25],
        i * 3,
      );
    const starsGeometry = new THREE.BufferGeometry();
    starsGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(starPositions, 3),
    );
    const starsMaterial = new THREE.PointsMaterial({
        color: 0x8294c7,
        size: 0.023,
        transparent: true,
        opacity: 0.65,
        sizeAttenuation: true,
        depthWrite: false,
      }),
      stars = new THREE.Points(starsGeometry, starsMaterial);
    scene.add(stars);
    const resize = () => {
      const rect = host.getBoundingClientRect(),
        w = Math.max(1, rect.width),
        h = Math.max(1, rect.height);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.position.z =
        camera.aspect < 0.8 ? 14 : camera.aspect < 1.3 ? 10.6 : 9.3;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    let targetActive = 0;
    const previousPointer = new THREE.Vector2();
    const pointerRotation = new THREE.Vector2();
    const rotationTarget = new THREE.Vector2();
    let hasRotationSample = false;
    let lastPointerMotion = -Infinity;
    let spinSpeed = MOTION.idleSpin;
    let autoYaw = 0.56;
    const pointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      targetActive = inside ? 1 : 0;
      const overControl =
        event.target instanceof Element &&
        Boolean(event.target.closest("a,button,input,textarea,select"));
      const canSteer =
        inside &&
        !overControl &&
        !reducedMotion &&
        Math.abs(pointer.x) < 0.85 &&
        Math.abs(pointer.y) < 0.8;

      if (canSteer && hasRotationSample) {
        const dx = THREE.MathUtils.clamp(
          pointer.x - previousPointer.x,
          -0.25,
          0.25,
        );
        const dy = THREE.MathUtils.clamp(
          pointer.y - previousPointer.y,
          -0.25,
          0.25,
        );
        rotationTarget.y += dx * 1.8;
        rotationTarget.x = THREE.MathUtils.clamp(
          rotationTarget.x - dy,
          -0.5,
          0.5,
        );
        if (Math.abs(dx) + Math.abs(dy) > 0.00005)
          lastPointerMotion = performance.now();
      }
      previousPointer.copy(pointer);
      hasRotationSample = canSteer;
    };
    const pointerLeave = () => {
      targetActive = 0;
      hasRotationSample = false;
    };
    window.addEventListener("pointermove", pointerMove, { passive: true });
    document.addEventListener("pointerleave", pointerLeave);
    let frame = 0,
      time = 0,
      previous = performance.now(),
      visible = true,
      lastPhase = "cube";
    const intersection = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
      },
      { rootMargin: "100px" },
    );
    intersection.observe(host);
    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      const elapsed = Math.min((now - previous) / 1000, 0.12);
      previous = now;
      if (!visible || document.hidden) return;
      if (!reducedMotion) time += elapsed;
      const cycle = time % MOTION.cycleSeconds;
      let morph = 0;
      if (cycle >= MOTION.toTreeStart && cycle < MOTION.toTreeEnd)
        morph = THREE.MathUtils.smoothstep(
          cycle,
          MOTION.toTreeStart,
          MOTION.toTreeEnd,
        );
      else if (cycle >= MOTION.toTreeEnd && cycle < MOTION.toCubeStart)
        morph = 1;
      else if (cycle >= MOTION.toCubeStart && cycle < MOTION.toCubeEnd)
        morph =
          1 -
          THREE.MathUtils.smoothstep(
            cycle,
            MOTION.toCubeStart,
            MOTION.toCubeEnd,
          );
      uniforms.uMorph.value = THREE.MathUtils.damp(
        uniforms.uMorph.value,
        morph,
        13,
        elapsed,
      );
      uniforms.uTime.value = time;
      uniforms.uActive.value = THREE.MathUtils.damp(
        uniforms.uActive.value,
        targetActive,
        9,
        elapsed,
      );

      // Cursor movement steers the object; automatic spin eases back in afterward.
      // Accumulating yaw avoids snapping back when the pointer leaves the scene.
      const steering = targetActive > 0 && now - lastPointerMotion < 180;
      spinSpeed = THREE.MathUtils.damp(
        spinSpeed,
        steering ? 0.06 : MOTION.idleSpin,
        8,
        elapsed,
      );
      if (!reducedMotion) autoYaw += spinSpeed * elapsed;
      if (!targetActive)
        rotationTarget.x = THREE.MathUtils.damp(
          rotationTarget.x,
          0,
          3,
          elapsed,
        );
      pointerRotation.x = THREE.MathUtils.damp(
        pointerRotation.x,
        rotationTarget.x,
        12,
        elapsed,
      );
      pointerRotation.y = THREE.MathUtils.damp(
        pointerRotation.y,
        rotationTarget.y,
        12,
        elapsed,
      );
      group.rotation.y = autoYaw + pointerRotation.y;
      group.rotation.x =
        0.045 +
        pointerRotation.x +
        Math.sin(time * 0.22) * 0.035 * (1 - uniforms.uMorph.value);
      edgeMaterial.uniforms.uMorph.value = uniforms.uMorph.value;
      edgeMaterial.uniforms.uTime.value = time;
      edgeMaterial.uniforms.uActive.value = uniforms.uActive.value;
      edgeMaterial.uniforms.uOpacity.value = (1 - uniforms.uMorph.value) * 2.2;
      reflectionMaterial.uniforms.uMorph.value = uniforms.uMorph.value;
      reflectionMaterial.uniforms.uTime.value = time;
      labelMaterial.opacity =
        Math.max(0, 1 - uniforms.uMorph.value * 2.5) * 0.93;
      floorMaterial.uniforms.uTime.value = time;
      // Turn the water surface as the shader sends ripples out from its center.
      floor.rotation.z = -time * 0.1;
      stars.rotation.y = time * 0.0009;
      const phase = uniforms.uMorph.value > 0.5 ? "tree" : "cube";
      if (lastPhase !== phase) {
        lastPhase = phase;
        options.current.onPhase?.(phase);
      }
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      window.removeEventListener("pointermove", pointerMove);
      document.removeEventListener("pointerleave", pointerLeave);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          object.geometry.dispose();
          const mats = Array.isArray(object.material)
            ? object.material
            : [object.material];
          mats.forEach((m: THREE.Material) => m.dispose());
        }
      });
      texture.dispose();
      renderer.dispose();
      if (host.contains(renderer.domElement))
        host.removeChild(renderer.domElement);
    };
  }, []);
  return (
    <div
      ref={container}
      className={`particle-scene${unavailable ? " scene-unavailable" : ""}`}
      role="img"
      aria-label="A fast-rotating blue particle cube repeatedly transforms into a branching tree above rippling water. Move your pointer to rotate the scene and bend the particles."
    >
      {unavailable && (
        <div className="scene-fallback">
          <div className="fallback-cube" />
          <span>{BRAND.short}</span>
        </div>
      )}
    </div>
  );
}
