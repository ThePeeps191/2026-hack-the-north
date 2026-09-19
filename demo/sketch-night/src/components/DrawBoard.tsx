import { useEffect, useRef, useState } from 'react';

const CANVAS_WIDTH = 720;
const CANVAS_HEIGHT = 420;
const PAPER = '#ece8e1';
const INK = ['#1c1e22', '#c45c4a', '#3d7ea6', '#5c8a5a', '#f0a868', '#6b4ea2'];

type DrawBoardProps = {
  prompt: string | null;
  submitted: boolean;
  onSubmit: (imageDataUrl: string) => void;
};

function pointFromEvent(event: PointerEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

export function DrawBoard({ prompt, submitted, onSubmit }: DrawBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [color, setColor] = useState(INK[0]!);
  const [size, setSize] = useState(6);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const down = (event: PointerEvent) => {
      if (submitted) {
        return;
      }
      drawing.current = true;
      canvas.setPointerCapture(event.pointerId);
      last.current = pointFromEvent(event, canvas);
    };

    const move = (event: PointerEvent) => {
      if (!drawing.current || submitted) {
        return;
      }
      const next = pointFromEvent(event, canvas);
      const prev = last.current ?? next;
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
      last.current = next;
    };

    const up = () => {
      drawing.current = false;
      last.current = null;
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', up);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', up);
    };
  }, [color, size, submitted]);

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || submitted) {
      return;
    }
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  const submit = () => {
    const canvas = canvasRef.current;
    if (!canvas || submitted) {
      return;
    }
    onSubmit(canvas.toDataURL('image/png'));
  };

  return (
    <section className="panel draw-board">
      <div className="draw-head">
        <h2>Draw</h2>
        {prompt ? <p className="prompt-line">{prompt}</p> : null}
      </div>
      <canvas
        ref={canvasRef}
        data-testid="draw-canvas"
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className={submitted ? 'is-locked' : undefined}
      />
      <div className="draw-tools">
        <div className="swatches" role="list" aria-label="Pen colour">
          {INK.map((value) => (
            <button
              key={value}
              type="button"
              role="listitem"
              className={value === color ? 'swatch is-active' : 'swatch'}
              style={{ background: value }}
              aria-label={value}
              disabled={submitted}
              onClick={() => setColor(value)}
            />
          ))}
        </div>
        <label className="brush">
          Brush
          <input
            type="range"
            min={2}
            max={24}
            value={size}
            disabled={submitted}
            onChange={(event) => setSize(Number(event.target.value))}
          />
        </label>
        <button type="button" className="btn-ghost" onClick={clear} disabled={submitted}>
          Clear
        </button>
        <button
          type="button"
          className="btn-primary"
          data-testid="submit-sketch"
          onClick={submit}
          disabled={submitted}
        >
          {submitted ? 'Submitted' : 'Submit sketch'}
        </button>
      </div>
      {submitted ? <p className="hint">Sketch in. Waiting on the rest of the table.</p> : null}
    </section>
  );
}
