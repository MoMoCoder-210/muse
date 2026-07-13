import { useEffect, useRef } from "react";
import { getCssVar } from "../../config/theme";

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  pulsePhase: number;
  pulseSpeed: number;
  color: string;
  energy: number; // 0~1，被光波击中时升高
}

interface Wave {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
  speed: number;
  thickness: number;
}

/**
 * 动态背景组件
 *
 */
export function DynamicBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const COLORS = [
      "37, 99, 235",    // 蓝
      "14, 165, 233",   // 青
      "168, 85, 247",   // 紫
      "249, 115, 22",   // 橙
    ];

    let W = 0;
    let H = 0;

    // ── 极光层配置 ─────────────────────────────
    const auroras = COLORS.map((color, i) => ({
      color,
      baseX: 0.2 + i * 0.2,
      baseY: 0.3 + (i % 2) * 0.25,
      radius: 0.35 + (i % 2) * 0.1,
      speedX: 0.0004 + i * 0.0001,
      speedY: 0.0003 + i * 0.00008,
      phase: i * Math.PI * 0.5,
      breatheSpeed: 0.002 + i * 0.0005,
    }));

    // ── 光纤节点 ───────────────────────────────
    const NODE_COUNT = 60;
    let nodes: Node[] = [];

    const initNodes = () => {
      nodes = Array.from({ length: NODE_COUNT }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        radius: 0.8 + Math.random() * 1.6,
        pulsePhase: Math.random() * Math.PI * 2,
        pulseSpeed: 0.01 + Math.random() * 0.025,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        energy: 0,
      }));
    };

    // ── 能量波纹池 ─────────────────────────────
    const waves: Wave[] = [];
    let waveSpawnTimer = 0;

    const spawnWave = () => {
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      waves.push({
        x: Math.random() * W,
        y: Math.random() * H,
        radius: 0,
        maxRadius: 200 + Math.random() * 250,
        color,
        speed: 1.8 + Math.random() * 1.2,
        thickness: 1.5,
      });
    };

    // ── 响应式 ─────────────────────────────────
    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initNodes();
    };
    resize();
    window.addEventListener("resize", resize);

    let frame = 0;
    let rafId = 0;

    // ── 鼠标状态 ───────────────────────────────
    const mouse = { x: -9999, y: -9999, vx: 0, vy: 0, lastX: 0, lastY: 0, active: false };
    let mouseWaveTimer = 0;

    const handleMouseMove = (e: MouseEvent) => {
      mouse.vx = e.clientX - mouse.lastX;
      mouse.vy = e.clientY - mouse.lastY;
      mouse.lastX = e.clientX;
      mouse.lastY = e.clientY;
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.active = true;
    };

    const handleMouseLeave = () => {
      mouse.active = false;
      mouse.x = -9999;
      mouse.y = -9999;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseleave", handleMouseLeave);

    // ── 绘制极光层（多层径向渐变叠加）────────
    const drawAuroras = () => {
      auroras.forEach((au) => {
        const bx = (au.baseX + Math.sin(frame * au.speedX + au.phase) * 0.12) * W;
        const by = (au.baseY + Math.cos(frame * au.speedY + au.phase) * 0.1) * H;
        const breathe = 1 + Math.sin(frame * au.breatheSpeed) * 0.15;
        const r = Math.min(W, H) * au.radius * breathe;

        // 外层弥散
        const grad1 = ctx.createRadialGradient(bx, by, 0, bx, by, r);
        grad1.addColorStop(0, `rgba(${au.color}, 0.12)`);
        grad1.addColorStop(0.4, `rgba(${au.color}, 0.04)`);
        grad1.addColorStop(1, `rgba(${au.color}, 0)`);
        ctx.fillStyle = grad1;
        ctx.fillRect(0, 0, W, H);
      });
    };

    // ── 绘制能量波纹 ───────────────────────────
    const drawWaves = () => {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i];
        w.radius += w.speed;

        // 衰减
        const lifeRatio = w.radius / w.maxRadius;
        if (lifeRatio >= 1) {
          waves.splice(i, 1);
          continue;
        }

        const alpha = (1 - lifeRatio) * 0.4;

        // 主圆环
        ctx.strokeStyle = `rgba(${w.color}, ${alpha})`;
        ctx.lineWidth = w.thickness;
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.radius, 0, Math.PI * 2);
        ctx.stroke();

        // 内层柔光
        const innerR = w.radius * 0.85;
        const glowGrad = ctx.createRadialGradient(w.x, w.y, innerR, w.x, w.y, w.radius);
        glowGrad.addColorStop(0, `rgba(${w.color}, 0)`);
        glowGrad.addColorStop(1, `rgba(${w.color}, ${alpha * 0.6})`);
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.radius, 0, Math.PI * 2);
        ctx.arc(w.x, w.y, innerR, 0, Math.PI * 2, true);
        ctx.fill();

        // 检测与节点碰撞 → 点亮节点
        nodes.forEach((node) => {
          const dist = Math.hypot(node.x - w.x, node.y - w.y);
          if (Math.abs(dist - w.radius) < 8) {
            node.energy = Math.min(1, node.energy + 0.6);
          }
        });
      }

      ctx.restore();
    };

    // ── 绘制光纤网络 ───────────────────────────
    const drawNetwork = () => {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      // 1. 连线
      const MAX_DIST = 170;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          if (dist > MAX_DIST) continue;

          const proximity = 1 - dist / MAX_DIST;
          const energyBoost = Math.max(a.energy, b.energy);
          const alpha = proximity * (0.08 + energyBoost * 0.35);

          // 能量传递时连线变亮变色
          const lineColor = energyBoost > 0.1 ? a.color : "148, 163, 184";
          ctx.strokeStyle = `rgba(${lineColor}, ${alpha})`;
          ctx.lineWidth = 0.5 + energyBoost * 1.5;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // 2. 节点
      nodes.forEach((node) => {
        node.pulsePhase += node.pulseSpeed;
        node.energy *= 0.96; // 能量衰减

        const pulse = 1 + Math.sin(node.pulsePhase) * 0.3;
        const energyGlow = node.energy * 12;
        const glowR = (node.radius * 3 + energyGlow) * pulse;

        // 能量光晕
        if (node.energy > 0.05) {
          const grad = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowR);
          grad.addColorStop(0, `rgba(${node.color}, ${node.energy * 0.8})`);
          grad.addColorStop(0.4, `rgba(${node.color}, ${node.energy * 0.2})`);
          grad.addColorStop(1, `rgba(${node.color}, 0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
          ctx.fill();
        }

        // 常规柔光
        const baseGlowR = node.radius * 4 * pulse;
        const baseGrad = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, baseGlowR);
        baseGrad.addColorStop(0, `rgba(${node.color}, 0.15)`);
        baseGrad.addColorStop(1, `rgba(${node.color}, 0)`);
        ctx.fillStyle = baseGrad;
        ctx.beginPath();
        ctx.arc(node.x, node.y, baseGlowR, 0, Math.PI * 2);
        ctx.fill();

        // 核心点
        const coreAlpha = 0.5 + node.energy * 0.5;
        ctx.fillStyle = `rgba(255, 255, 255, ${coreAlpha})`;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius * (0.7 + node.energy * 0.5), 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.restore();
    };

    // ── 更新节点位置 ───────────────────────────
    const updateNodes = () => {
      nodes.forEach((node) => {
        // 速度衰减防止累积过快
        node.vx *= 0.985;
        node.vy *= 0.985;

        // 最低速度保证持续移动
        const speed = Math.hypot(node.vx, node.vy);
        if (speed < 0.1) {
          node.vx += (Math.random() - 0.5) * 0.05;
          node.vy += (Math.random() - 0.5) * 0.05;
        }

        node.x += node.vx;
        node.y += node.vy;

        // 边界反弹（柔和）
        if (node.x < 0) { node.x = 0; node.vx *= -0.8; }
        if (node.x > W) { node.x = W; node.vx *= -0.8; }
        if (node.y < 0) { node.y = 0; node.vy *= -0.8; }
        if (node.y > H) { node.y = H; node.vy *= -0.8; }
      });
    };

    // ── 主循环 ─────────────────────────────────
    const render = () => {
      frame += 1;

      const bgCanvas = getCssVar("bgCanvas");
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = bgCanvas;
      ctx.fillRect(0, 0, W, H);

      // 1. 极光底层
      drawAuroras();

      // 2. 光纤网络
      drawNetwork();

      // 3. 能量波纹（最上层）
      drawWaves();

      // 4. 更新节点
      updateNodes();

      // 5. 定时生成随机波纹
      waveSpawnTimer += 1;
      if (waveSpawnTimer > 90 + Math.random() * 60) {
        spawnWave();
        waveSpawnTimer = 0;
      }

      // 6. 鼠标快速移动时生成跟随波纹
      mouseWaveTimer += 1;
      const mouseSpeed = Math.hypot(mouse.vx, mouse.vy);
      if (mouse.active && mouseSpeed > 15 && mouseWaveTimer > 25) {
        waves.push({
          x: mouse.x,
          y: mouse.y,
          radius: 0,
          maxRadius: 100 + Math.random() * 60,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          speed: 1.2,
          thickness: 1,
        });
        mouseWaveTimer = 0;
      }
      // 鼠标速度衰减
      mouse.vx *= 0.85;
      mouse.vy *= 0.85;

      rafId = window.requestAnimationFrame(render);
    };

    rafId = window.requestAnimationFrame(render);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseleave", handleMouseLeave);
      window.cancelAnimationFrame(rafId);
    };
  }, []);

  return <canvas ref={canvasRef} className="backdrop-canvas" aria-hidden="true" />;
}
