# gen-pet-assets.ps1 — 生成桌面宠物 PNG 素材（C# GDI+ 移植 drawPetImage）
# 输出: <脚本目录>/assets/{preset}-{mood}.png
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;

public static class PetGen {
  // Per-mood frame sequences: whole-canvas tilt angles (Codex-style frames).
  static readonly Dictionary<string, float[]> frameAngles = new Dictionary<string, float[]> {
    { "think", new float[] { -9f, 0f, 9f } },
    { "happy", new float[] { -12f, 12f, -12f, 12f } },
    { "sleepy", new float[] { 3f, -3f } },
    { "run", new float[] { -8f, 8f } }
  };
  static Color Hex(string h) { return ColorTranslator.FromHtml(h); }
  static Color Shade(Color c, double amt) {
    int t = amt >= 0 ? 255 : 0; double k = Math.Abs(amt);
    return Color.FromArgb((int)(c.R + (t - c.R) * k), (int)(c.G + (t - c.G) * k), (int)(c.B + (t - c.B) * k));
  }
  static void Ellipse(Graphics g, float cx, float cy, float rx, float ry, Color fill, Pen stroke, bool fillOnly) {
    var rect = new RectangleF(cx - rx, cy - ry, rx * 2, ry * 2);
    if (fillOnly) { using (var b = new SolidBrush(fill)) g.FillEllipse(b, rect); }
    else { using (var b = new SolidBrush(fill)) g.FillEllipse(b, rect); g.DrawEllipse(stroke, rect); }
  }
  // quadratic bezier -> cubic, drawn as a stroked path
  static void QCurve(Graphics g, Pen pen, float x0, float y0, float cx, float cy, float x1, float y1) {
    float c1x = x0 + (cx - x0) * 2f / 3f, c1y = y0 + (cy - y0) * 2f / 3f;
    float c2x = x1 + (cx - x1) * 2f / 3f, c2y = y1 + (cy - y1) * 2f / 3f;
    g.DrawBezier(pen, x0, y0, c1x, c1y, c2x, c2y, x1, y1);
  }
  static void Line(Graphics g, Pen pen, float x0, float y0, float x1, float y1) {
    g.DrawLine(pen, x0, y0, x1, y1);
  }

  public static void Generate(string outDir, string preset, string kind, int S, string[] pal, string[] moods) {
    Directory.CreateDirectory(outDir);
    var dom = Hex(pal[0]); var sec = Hex(pal[1]); var acc = Hex(pal[2]); var lit = Hex(pal[3]);
    var stroke = Shade(dom, -0.38);
    float lw = Math.Max(1.5f, S * 0.018f);
    float lw2 = Math.Max(1.2f, S * 0.014f);
    float lw3 = Math.Max(1.5f, S * 0.016f);

    foreach (var mood in moods) {
      // Frame sequences per mood: whole-canvas tilt angles (Codex-style frame
      // animation). mood-0 keeps the legacy single-frame name too.
      float[] angles;
      if (!frameAngles.TryGetValue(mood, out angles)) angles = new float[] { 0f };
      for (int fi = 0; fi < angles.Length; fi++) {
        float angle = angles[fi];
        using (var bmp = new Bitmap(S, S))
        using (var g = Graphics.FromImage(bmp)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        if (angle != 0f) {
          g.TranslateTransform(S / 2f, S / 2f);
          g.RotateTransform(angle);
          g.TranslateTransform(-S / 2f, -S / 2f);
        }
        var pen = new Pen(stroke, lw); pen.LineJoin = LineJoin.Round; pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
        var pen2 = new Pen(stroke, lw2); pen2.StartCap = LineCap.Round; pen2.EndCap = LineCap.Round;
        var pen3 = new Pen(stroke, lw3); pen3.StartCap = LineCap.Round; pen3.EndCap = LineCap.Round;

        // ground shadow
        if (mood != "grabbed") { using (var b = new SolidBrush(Color.FromArgb(30, 0, 0, 0))) g.FillEllipse(b, S * 0.24f, S * 0.855f, S * 0.52f, S * 0.09f); }

        // ---- ears / horns / fins per kind ----
        if (kind == "cat") {
          foreach (var ex in new float[] { S * 0.34f, S * 0.66f }) {
            var pts = new PointF[] { new PointF(ex - S * 0.09f, S * 0.36f), new PointF(ex, S * 0.15f), new PointF(ex + S * 0.09f, S * 0.36f) };
            using (var b = new SolidBrush(sec)) g.FillPolygon(b, pts);
            g.DrawPolygon(pen, pts);
            var pts2 = new PointF[] { new PointF(ex - S * 0.045f, S * 0.33f), new PointF(ex, S * 0.21f), new PointF(ex + S * 0.045f, S * 0.33f) };
            using (var b = new SolidBrush(lit)) g.FillPolygon(b, pts2);
          }
        } else if (kind == "rabbit") {
          foreach (var ex in new float[] { S * 0.36f, S * 0.64f }) {
            Ellipse(g, ex, S * 0.24f, S * 0.055f, S * 0.14f, sec, pen, false);
            Ellipse(g, ex, S * 0.25f, S * 0.024f, S * 0.085f, lit, null, true);
          }
        } else if (kind == "dog") {
          foreach (var ex in new float[] { S * 0.34f, S * 0.66f }) {
            using (var path = new GraphicsPath()) {
              path.AddEllipse(ex - S * 0.08f, S * 0.25f, S * 0.16f, S * 0.26f);
              var m = new Matrix(); m.RotateAt(14f, new PointF(ex, S * 0.38f)); path.Transform(m);
              using (var b = new SolidBrush(sec)) g.FillPath(b, path);
              g.DrawPath(pen, path);
            }
          }
        } else if (kind == "dragon") {
          foreach (var ex in new float[] { S * 0.34f, S * 0.66f }) {
            using (var path = new GraphicsPath()) {
              path.StartFigure();
              path.AddBezier(ex - S * 0.07f, S * 0.35f, ex, S * 0.10f, ex + S * 0.02f, S * 0.10f, ex + S * 0.02f, S * 0.10f);
              path.AddBezier(ex + S * 0.02f, S * 0.10f, ex - S * 0.02f, S * 0.22f, ex + S * 0.07f, S * 0.35f, ex + S * 0.07f, S * 0.35f);
              path.CloseFigure();
              using (var b = new SolidBrush(sec)) g.FillPath(b, path);
              g.DrawPath(pen, path);
            }
          }
        } else if (kind == "whale") {
          var spen = new Pen(acc, Math.Max(1.5f, S * 0.016f)); spen.StartCap = LineCap.Round; spen.EndCap = LineCap.Round;
          g.DrawArc(spen, S * 0.5f - S * 0.035f, S * 0.20f - S * 0.035f, S * 0.07f, S * 0.07f, 198f, 144f);
          g.DrawArc(spen, S * 0.5f - S * 0.022f, S * 0.18f - S * 0.022f, S * 0.044f, S * 0.044f, 198f, 144f);
          using (var path = new GraphicsPath()) {
            path.StartFigure();
            path.AddBezier(S * 0.82f, S * 0.52f, S * 0.9133f, S * 0.4667f, S * 0.9267f, S * 0.52f, S * 0.94f, S * 0.56f);
            path.AddBezier(S * 0.94f, S * 0.56f, S * 0.9533f, S * 0.60f, S * 0.9067f, S * 0.5533f, S * 0.80f, S * 0.58f);
            path.CloseFigure();
            using (var b = new SolidBrush(sec)) g.FillPath(b, path);
            g.DrawPath(pen, path);
          }
        }

        // ---- body ----
        using (var b = new SolidBrush(dom)) g.FillEllipse(b, S * 0.16f, S * 0.21f, S * 0.68f, S * 0.62f);
        g.DrawEllipse(pen, S * 0.16f, S * 0.21f, S * 0.68f, S * 0.62f);
        // belly
        Ellipse(g, S * 0.5f, S * 0.60f, S * 0.17f, S * 0.13f, Color.FromArgb(191, lit), null, true);

        // ---- face per mood ----
        float ex1 = S * 0.42f, ex2 = S * 0.58f, ey = S * 0.45f;
        if (mood == "happy" || mood == "think" || mood == "run") {
          foreach (var ex in new float[] { ex1, ex2 }) {
            QCurve(g, pen3, ex - S * 0.045f, ey + S * 0.02f, ex, ey - S * 0.045f, ex + S * 0.045f, ey + S * 0.02f);
          }
          if (mood == "think") {
            using (var b = new SolidBrush(stroke)) {
              g.FillEllipse(b, ex1 - S * 0.014f, ey - S * 0.089f, S * 0.028f, S * 0.028f);
              g.FillEllipse(b, ex2 - S * 0.014f, ey - S * 0.089f, S * 0.028f, S * 0.028f);
            }
          }
        } else if (mood == "alert") {
          foreach (var ex in new float[] { ex1, ex2 }) {
            using (var b = new SolidBrush(Color.White)) g.FillEllipse(b, ex - S * 0.07f, ey - S * 0.088f, S * 0.14f, S * 0.176f);
            g.DrawEllipse(new Pen(stroke, Math.Max(1f, S * 0.010f)), ex - S * 0.07f, ey - S * 0.088f, S * 0.14f, S * 0.176f);
            using (var b = new SolidBrush(Color.FromArgb(38, 34, 46))) g.FillEllipse(b, ex - S * 0.022f, ey - S * 0.018f, S * 0.044f, S * 0.044f);
          }
        } else if (mood == "grabbed") {
          // > < eyes
          Line(g, pen3, ex1 - S * 0.05f, ey - S * 0.03f, ex1 + S * 0.04f, ey + S * 0.035f);
          Line(g, pen3, ex1 - S * 0.02f, ey + S * 0.05f, ex1 + S * 0.04f, ey + S * 0.035f);
          Line(g, pen3, ex2 + S * 0.05f, ey - S * 0.03f, ex2 - S * 0.04f, ey + S * 0.035f);
          Line(g, pen3, ex2 + S * 0.02f, ey + S * 0.05f, ex2 - S * 0.04f, ey + S * 0.035f);
          // wavy mouth
          QCurve(g, pen2, S * 0.44f, S * 0.56f, S * 0.47f, S * 0.545f, S * 0.50f, S * 0.56f);
          QCurve(g, pen2, S * 0.50f, S * 0.56f, S * 0.53f, S * 0.575f, S * 0.56f, S * 0.56f);
          // sweat drop
          Ellipse(g, S * 0.70f, S * 0.30f, S * 0.022f, S * 0.032f, Color.FromArgb(126, 200, 255), null, true);
        } else if (mood == "sleepy") {
          foreach (var ex in new float[] { ex1, ex2 }) {
            QCurve(g, pen3, ex - S * 0.045f, ey, ex, ey + S * 0.03f, ex + S * 0.045f, ey);
          }
        } else { // normal
          foreach (var ex in new float[] { ex1, ex2 }) {
            using (var b = new SolidBrush(Color.White)) g.FillEllipse(b, ex - S * 0.062f, ey - S * 0.080f, S * 0.124f, S * 0.160f);
            using (var b = new SolidBrush(Color.FromArgb(38, 34, 46))) g.FillEllipse(b, ex - S * 0.033f, ey - S * 0.015f, S * 0.066f, S * 0.066f);
            using (var b = new SolidBrush(Color.White)) g.FillEllipse(b, ex - S * 0.023f, ey - S * 0.046f, S * 0.022f, S * 0.022f);
          }
        }

        // blush
        foreach (var ex in new float[] { S * 0.305f, S * 0.695f }) {
          Ellipse(g, ex, S * 0.545f, S * 0.052f, S * 0.026f, Color.FromArgb(102, acc), null, true);
        }

        // ---- mouth ----
        if (mood == "happy" || mood == "normal" || mood == "think" || mood == "run") {
          QCurve(g, pen2, S * 0.46f, S * 0.545f, S * 0.5f, S * 0.585f, S * 0.54f, S * 0.545f);
        } else if (mood == "alert") {
          g.DrawEllipse(pen2, S * 0.48f, S * 0.535f, S * 0.04f, S * 0.04f);
        } else if (mood == "sleepy") {
          Line(g, pen2, S * 0.47f, S * 0.555f, S * 0.53f, S * 0.555f);
        }
        // dog tongue
        if (kind == "dog" && mood != "grabbed") {
          Ellipse(g, S * 0.5f, S * 0.595f, S * 0.016f, S * 0.024f, Color.FromArgb(255, 143, 143), null, true);
        }
        // cat whiskers
        if (kind == "cat") {
          var wpen = new Pen(Color.FromArgb(140, stroke), Math.Max(1f, S * 0.008f));
          Line(g, wpen, S * 0.32f, S * 0.50f, S * 0.22f, S * 0.47f);
          Line(g, wpen, S * 0.32f, S * 0.54f, S * 0.21f, S * 0.54f);
          Line(g, wpen, S * 0.68f, S * 0.50f, S * 0.78f, S * 0.47f);
          Line(g, wpen, S * 0.68f, S * 0.54f, S * 0.79f, S * 0.54f);
        }
        // sparkle
        using (var b = new SolidBrush(acc)) {
          g.FillEllipse(b, S * 0.80f - S * 0.022f, S * 0.18f - S * 0.022f, S * 0.044f, S * 0.044f);
          g.FillEllipse(b, S * 0.755f - S * 0.014f, S * 0.225f - S * 0.014f, S * 0.028f, S * 0.028f);
        }

        bmp.Save(Path.Combine(outDir, preset + "-" + mood + "-" + fi + ".png"), System.Drawing.Imaging.ImageFormat.Png);
        if (angle == 0f) {
          bmp.Save(Path.Combine(outDir, preset + "-" + mood + ".png"), System.Drawing.Imaging.ImageFormat.Png);
        }
        pen.Dispose(); pen2.Dispose(); pen3.Dispose();
        }
      }
    }
  }
}
'@

Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing

$outDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'assets'
$presets = @{
  cat    = @('#f5a25d', '#e0843c', '#ff9ecb', '#fff3e4')
  rabbit = @('#f2b8d0', '#e897b9', '#ff7eb3', '#fff0f6')
  whale  = @('#6fa8dc', '#4f8cc4', '#8ec9ff', '#e8f4ff')
  dragon = @('#7fc47f', '#5aa35a', '#ffd166', '#eef8ee')
  dog    = @('#e8b57b', '#d19a55', '#ff8f8f', '#fdf3e4')
}
$kinds = @{ cat = 'cat'; rabbit = 'rabbit'; whale = 'whale'; dragon = 'dragon'; dog = 'dog' }
$moods = @('normal', 'happy', 'alert', 'grabbed', 'think', 'sleepy', 'run')

foreach ($key in $presets.Keys) {
  [PetGen]::Generate($outDir, $key, $kinds[$key], 240, [string[]]$presets[$key], [string[]]$moods)
  Write-Host "generated: $key"
}
Write-Host "done -> $outDir"



