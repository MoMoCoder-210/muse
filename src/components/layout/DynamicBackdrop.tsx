import { useEffect, useRef } from "react";
import { getCssVar } from "../../config/theme";

interface FlowRibbon {
  y: number;
  amplitude: number;
  width: number;
  phase: number;
  speed: number;
  color: string;
  alpha: number;
}

interface GlassLens {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  rotation: number;
  phase: number;
  speed: number;
  color: string;
}

interface AmbientOrb {
  x: number;
  y: number;
  radius: number;
  color: string;
  alpha: number;
  phase: number;
  speed: number;
  driftX: number;
  driftY: number;
}

/**
 * Muse 流体智能桌面：macOS 动态壁纸的柔和环境光，加上轻量的创作结构纹理。
 *
 * 背景不承载交互内容，不使用节点、粒子、圆环或霓虹边缘；所有结构都以低
 * 对比度绘制在半透明页面层之后，保持 Apple 风格的安静和空间感。
 */
export function DynamicBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const background = getCssVar("bgCanvas") || "#090d14";
    // 以 SF 蓝/青为底，用紫、玫红、薄荷和暖橙拉开冷暖层次。
    // 辅助色透明度很低，只负责空间色温，不制造霓虹灯效果。
    const palette = [
      getCssVar("canvasGlow1") || "0, 113, 227", // 蓝
      getCssVar("canvasGlow2") || "90, 200, 250", // 青
      getCssVar("canvasGlow3") || "191, 90, 242", // 紫
      getCssVar("canvasGlow4") || "255, 159, 10", // 橙
      getCssVar("colorDangerRgb") || "255, 69, 58", // 玫红
      getCssVar("colorSuccessRgb") || "48, 209, 88", // 薄荷绿
    ];

    let width = 0;
    let height = 0;
    let devicePixelRatio = 1;
    let ribbons: FlowRibbon[] = [];
    let lenses: GlassLens[] = [];
    let orbs: AmbientOrb[] = [];
    let noisePattern: CanvasPattern | null = null;
    let animationId = 0;
    let lastPaint = 0;
    let reducedMotion = false;

    const mouse = { x: -1000, y: -1000, active: false };

    const createNoisePattern = () => {
      const tile = document.createElement("canvas");
      const size = 96;
      tile.width = size;
      tile.height = size;
      const tileContext = tile.getContext("2d");
      if (!tileContext) return null;

      const image = tileContext.createImageData(size, size);
      for (let i = 0; i < image.data.length; i += 4) {
        const value = Math.random() > 0.5 ? 255 : 0;
        image.data[i] = value;
        image.data[i + 1] = value;
        image.data[i + 2] = value;
        image.data[i + 3] = 11;
      }
      tileContext.putImageData(image, 0, 0);
      return ctx.createPattern(tile, "repeat");
    };

    const initScene = () => {
      const shortSide = Math.min(width, height);
      ribbons = [
        { y: 0.08, amplitude: shortSide * 0.07, width: shortSide * 0.2, phase: 0.8, speed: 0.000018, color: palette[1], alpha: 0.062 },
        { y: 0.27, amplitude: shortSide * 0.085, width: shortSide * 0.23, phase: 1.9, speed: 0.000016, color: palette[2], alpha: 0.056 },
        { y: 0.46, amplitude: shortSide * 0.1, width: shortSide * 0.25, phase: 2.8, speed: 0.000014, color: palette[4], alpha: 0.045 },
        { y: 0.64, amplitude: shortSide * 0.085, width: shortSide * 0.24, phase: 3.6, speed: 0.000013, color: palette[5], alpha: 0.034 },
        { y: 0.8, amplitude: shortSide * 0.08, width: shortSide * 0.22, phase: 4.5, speed: 0.000011, color: palette[0], alpha: 0.058 },
        { y: 0.96, amplitude: shortSide * 0.06, width: shortSide * 0.19, phase: 5.2, speed: 0.000009, color: palette[3], alpha: 0.042 },
      ];

      lenses = [
        { x: 0.06, y: 0.2, radiusX: width * 0.46, radiusY: shortSide * 0.18, rotation: -0.18, phase: 0.2, speed: 0.000012, color: palette[2] },
        { x: 0.84, y: 0.42, radiusX: width * 0.4, radiusY: shortSide * 0.15, rotation: -0.22, phase: 2.8, speed: 0.000009, color: palette[4] },
        { x: 0.86, y: 0.82, radiusX: width * 0.34, radiusY: shortSide * 0.12, rotation: 0.16, phase: 4.2, speed: 0.000011, color: palette[1] },
        { x: 0.2, y: 0.92, radiusX: width * 0.26, radiusY: shortSide * 0.1, rotation: 0.2, phase: 5.4, speed: 0.00001, color: palette[5] },
      ];

      orbs = [
        { x: -0.02, y: -0.03, radius: shortSide * 0.72, color: palette[2], alpha: 0.095, phase: 0.5, speed: 0.000014, driftX: 0.08, driftY: 0.05 },
        { x: 0.95, y: 0.04, radius: shortSide * 0.68, color: palette[1], alpha: 0.1, phase: 2.2, speed: 0.000012, driftX: 0.07, driftY: 0.06 },
        { x: 1.02, y: 0.6, radius: shortSide * 0.72, color: palette[0], alpha: 0.075, phase: 3.9, speed: 0.00001, driftX: 0.06, driftY: 0.045 },
        { x: -0.02, y: 0.5, radius: shortSide * 0.5, color: palette[4], alpha: 0.058, phase: 4.1, speed: 0.000009, driftX: 0.05, driftY: 0.04 },
        { x: 0.28, y: 1.04, radius: shortSide * 0.54, color: palette[5], alpha: 0.04, phase: 5.3, speed: 0.000008, driftX: 0.05, driftY: 0.035 },
        { x: 1.02, y: 1.03, radius: shortSide * 0.5, color: palette[3], alpha: 0.052, phase: 1.6, speed: 0.000007, driftX: 0.045, driftY: 0.04 },
      ];
    };

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * devicePixelRatio);
      canvas.height = Math.floor(height * devicePixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      initScene();
      if (reducedMotion) draw(0);
    };

    const drawBase = () => {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      const baseGradient = ctx.createLinearGradient(0, 0, width, height);
      baseGradient.addColorStop(0, `rgba(${palette[2]}, 0.055)`);
      baseGradient.addColorStop(0.22, `rgba(${palette[4]}, 0.02)`);
      baseGradient.addColorStop(0.44, "rgba(255, 255, 255, 0)");
      baseGradient.addColorStop(0.68, `rgba(${palette[0]}, 0.026)`);
      baseGradient.addColorStop(0.84, `rgba(${palette[5]}, 0.014)`);
      baseGradient.addColorStop(1, `rgba(${palette[3]}, 0.045)`);
      ctx.fillStyle = baseGradient;
      ctx.fillRect(0, 0, width, height);
    };

    const drawPrismWashes = (time: number) => {
      const drift = Math.sin(time * 0.000012) * width * 0.12;

      // 两层大尺度棱镜洗染，让冷暖色在背景中形成明确的对角分区。
      const diagonal = ctx.createLinearGradient(-width * 0.2 + drift, height, width * 0.82 + drift, 0);
      diagonal.addColorStop(0, `rgba(${palette[3]}, 0.045)`);
      diagonal.addColorStop(0.22, `rgba(${palette[4]}, 0.034)`);
      diagonal.addColorStop(0.43, `rgba(${palette[2]}, 0.028)`);
      diagonal.addColorStop(0.64, `rgba(${palette[1]}, 0.018)`);
      diagonal.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = diagonal;
      ctx.fillRect(0, 0, width, height);

      const counterDrift = Math.cos(time * 0.000009) * width * 0.1;
      const counter = ctx.createLinearGradient(width * 0.2 + counterDrift, 0, width * 1.1 + counterDrift, height);
      counter.addColorStop(0, `rgba(${palette[1]}, 0)`);
      counter.addColorStop(0.35, `rgba(${palette[1]}, 0.016)`);
      counter.addColorStop(0.58, `rgba(${palette[5]}, 0.018)`);
      counter.addColorStop(0.78, `rgba(${palette[0]}, 0.026)`);
      counter.addColorStop(1, `rgba(${palette[2]}, 0.035)`);
      ctx.fillStyle = counter;
      ctx.fillRect(0, 0, width, height);
    };

    const drawAmbientOrbs = (time: number) => {
      orbs.forEach((orb) => {
        const phase = time * orb.speed + orb.phase;
        let x = orb.x * width + Math.sin(phase) * width * orb.driftX;
        let y = orb.y * height + Math.cos(phase * 0.8) * height * orb.driftY;

        if (mouse.active) {
          const influence = Math.max(0, 1 - Math.hypot(x - mouse.x, y - mouse.y) / 560);
          x += (mouse.x - x) * influence * 0.014;
          y += (mouse.y - y) * influence * 0.014;
        }

        const radius = orb.radius * (1 + Math.sin(phase * 1.2) * 0.035);
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `rgba(${orb.color}, ${orb.alpha})`);
        gradient.addColorStop(0.32, `rgba(${orb.color}, ${orb.alpha * 0.48})`);
        gradient.addColorStop(0.7, `rgba(${orb.color}, ${orb.alpha * 0.1})`);
        gradient.addColorStop(1, `rgba(${orb.color}, 0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      });
    };

    const ribbonY = (ribbon: FlowRibbon, x: number, time: number, offset = 0) => {
      const normalizedX = x / Math.max(width, 1);
      const longWave = Math.sin(normalizedX * 4.2 + ribbon.phase + time * ribbon.speed) * ribbon.amplitude;
      const softWave = Math.sin(normalizedX * 9.4 - ribbon.phase * 0.65 + time * ribbon.speed * 1.7) * ribbon.amplitude * 0.24;
      const cursorLift = mouse.active
        ? Math.max(0, 1 - Math.hypot(x - mouse.x, ribbon.y * height - mouse.y) / 280) * 8
        : 0;
      return ribbon.y * height + longWave + softWave + offset - cursorLift;
    };

    const traceRibbonShape = (ribbon: FlowRibbon, time: number) => {
      const top = -ribbon.width * 0.5;
      const bottom = ribbon.width * 0.5;
      ctx.beginPath();
      for (let x = -60; x <= width + 60; x += 26) {
        const y = ribbonY(ribbon, x, time, top);
        if (x === -60) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let x = width + 60; x >= -60; x -= 26) {
        ctx.lineTo(x, ribbonY(ribbon, x, time, bottom));
      }
      ctx.closePath();
    };

    const drawRibbon = (ribbon: FlowRibbon, time: number) => {
      // 用填充形状而不是路径描边，保留流动体积感，去掉线条轮廓。
      ctx.save();
      ctx.filter = `blur(${ribbon.width * 0.16}px)`;
      ctx.fillStyle = `rgba(${ribbon.color}, ${ribbon.alpha})`;
      traceRibbonShape(ribbon, time);
      ctx.fill();
      ctx.restore();
    };

    const drawRibbons = (time: number) => {
      ribbons.forEach((ribbon) => drawRibbon(ribbon, time));
    };

    const drawGlassLenses = (time: number) => {
      lenses.forEach((lens, index) => {
        const phase = time * lens.speed + lens.phase;
        const x = lens.x * width + Math.sin(phase) * width * 0.035;
        const y = lens.y * height + Math.cos(phase * 0.8) * height * 0.025;
        const rotation = lens.rotation + Math.sin(phase * 0.7) * 0.035;

        // 玻璃面使用柔和的实心椭圆雾层，不绘制边缘或反射线。
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rotation);
        ctx.filter = "blur(30px)";
        const lensGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, lens.radiusX);
        const alpha = index === 0 ? 0.052 : index === 1 ? 0.044 : 0.036;
        lensGradient.addColorStop(0, `rgba(${lens.color}, ${alpha})`);
        lensGradient.addColorStop(0.58, `rgba(${lens.color}, ${alpha * 0.38})`);
        lensGradient.addColorStop(1, `rgba(${lens.color}, 0)`);
        ctx.fillStyle = lensGradient;
        ctx.beginPath();
        ctx.ellipse(0, 0, lens.radiusX, lens.radiusY, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    };

    const drawMovingSheen = (time: number) => {
      const x = ((time * 0.011) % (width + 680)) - 340;
      const sheen = ctx.createLinearGradient(x, 0, x + 420, height);
      sheen.addColorStop(0, "rgba(255, 255, 255, 0)");
      sheen.addColorStop(0.5, "rgba(255, 255, 255, 0.012)");
      sheen.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, width, height);
    };

    const drawVignette = () => {
      const vignette = ctx.createRadialGradient(
        width * 0.5,
        height * 0.44,
        Math.min(width, height) * 0.14,
        width * 0.5,
        height * 0.44,
        Math.max(width, height) * 0.84,
      );
      vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
      vignette.addColorStop(0.7, "rgba(0, 0, 0, 0.018)");
      vignette.addColorStop(1, "rgba(0, 0, 0, 0.2)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, width, height);
    };

    const drawNoise = () => {
      if (!noisePattern) return;
      ctx.save();
      ctx.globalAlpha = 0.022;
      ctx.fillStyle = noisePattern;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    };

    const draw = (time: number) => {
      ctx.clearRect(0, 0, width, height);
      drawBase();
      drawPrismWashes(time);
      drawAmbientOrbs(time);
      drawRibbons(time);
      drawGlassLenses(time);
      drawMovingSheen(time);
      drawVignette();
      drawNoise();
    };

    const render = (timestamp: number) => {
      if (timestamp - lastPaint >= 32) {
        lastPaint = timestamp;
        draw(reducedMotion ? 0 : timestamp);
      }
      if (!reducedMotion) animationId = window.requestAnimationFrame(render);
    };

    const handleMouseMove = (event: MouseEvent) => {
      mouse.x = event.clientX;
      mouse.y = event.clientY;
      mouse.active = true;
    };

    const handleMouseLeave = () => {
      mouse.active = false;
    };

    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    noisePattern = createNoisePattern();
    resize();
    draw(0);

    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseleave", handleMouseLeave);

    if (!reducedMotion) animationId = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseleave", handleMouseLeave);
      window.cancelAnimationFrame(animationId);
    };
  }, []);

  return <canvas ref={canvasRef} className="backdrop-canvas" aria-hidden="true" />;
}
