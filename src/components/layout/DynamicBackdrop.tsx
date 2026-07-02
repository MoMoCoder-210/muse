import { useEffect, useRef } from "react";
import { getCssVar } from "../../config/theme";

/**
 * 动态背景组件
 *
 * 使用 Canvas 渲染粒子动画与光晕效果，作为应用全局背景。
 *
 * @author yt @date 20260702
 */
export function DynamicBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const particles = Array.from({ length: 34 }, (_, index) => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00045,
      vy: (Math.random() - 0.5) * 0.00045,
      size: 1 + (index % 3),
    }));

    const resize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener("resize", resize);

    let frame = 0;
    let rafId = 0;

    const drawGlow = (
      x: number,
      y: number,
      radius: number,
      innerColor: string,
      outerColor: string,
    ) => {
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, innerColor);
      gradient.addColorStop(1, outerColor);
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    };

    const render = () => {
      frame += 1;
      const width = window.innerWidth;
      const height = window.innerHeight;

      const bgCanvas = getCssVar("bgCanvas");
      const glow1 = getCssVar("canvasGlow1");
      const glow2 = getCssVar("canvasGlow2");
      const glow3 = getCssVar("canvasGlow3");
      const glow4 = getCssVar("canvasGlow4");
      const particleColor = getCssVar("canvasParticleColor");
      const lineRgb = getCssVar("canvasLineColor");

      context.clearRect(0, 0, width, height);
      context.fillStyle = bgCanvas;
      context.fillRect(0, 0, width, height);

      const baseX = width * 0.5;
      const baseY = height * 0.5;

      drawGlow(
        baseX + Math.sin(frame * 0.003) * width * 0.2,
        baseY + Math.cos(frame * 0.0027) * height * 0.18,
        Math.min(width, height) * 0.42,
        `rgba(${glow1}, 0.33)`,
        `rgba(${glow1}, 0)`,
      );
      drawGlow(
        baseX - Math.cos(frame * 0.0022) * width * 0.24,
        baseY - Math.sin(frame * 0.0024) * height * 0.2,
        Math.min(width, height) * 0.34,
        `rgba(${glow2}, 0.28)`,
        `rgba(${glow2}, 0)`,
      );
      drawGlow(
        baseX + Math.sin(frame * 0.002) * width * 0.12,
        baseY + Math.sin(frame * 0.0032) * height * 0.12,
        Math.min(width, height) * 0.24,
        `rgba(${glow3}, 0.22)`,
        `rgba(${glow3}, 0)`,
      );
      drawGlow(
        width * 0.18 + Math.sin(frame * 0.0018) * width * 0.12,
        height * 0.2 + Math.cos(frame * 0.0025) * height * 0.1,
        Math.min(width, height) * 0.18,
        `rgba(${glow4}, 0.18)`,
        `rgba(${glow4}, 0)`,
      );

      context.save();
      context.globalCompositeOperation = "lighter";

      particles.forEach((particle, index) => {
        particle.x += particle.vx;
        particle.y += particle.vy;

        if (particle.x < -0.05) particle.x = 1.05;
        if (particle.x > 1.05) particle.x = -0.05;
        if (particle.y < -0.05) particle.y = 1.05;
        if (particle.y > 1.05) particle.y = -0.05;

        const px = particle.x * width;
        const py = particle.y * height;
        context.fillStyle = particleColor;
        context.beginPath();
        context.arc(px, py, particle.size, 0, Math.PI * 2);
        context.fill();

        for (let otherIndex = index + 1; otherIndex < particles.length; otherIndex += 1) {
          const other = particles[otherIndex];
          const ox = other.x * width;
          const oy = other.y * height;
          const dx = ox - px;
          const dy = oy - py;
          const distance = Math.hypot(dx, dy);
          if (distance > 160) continue;

          const alpha = (1 - distance / 160) * 0.18;
          context.strokeStyle = `rgba(${lineRgb}, ${alpha})`;
          context.beginPath();
          context.moveTo(px, py);
          context.lineTo(ox, oy);
          context.stroke();
        }
      });

      context.restore();
      rafId = window.requestAnimationFrame(render);
    };

    rafId = window.requestAnimationFrame(render);
    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(rafId);
    };
  }, []);

  return <canvas ref={canvasRef} className="backdrop-canvas" aria-hidden="true" />;
}
