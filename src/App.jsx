import { useState, useRef, useEffect, useCallback } from "react";

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQueue(words, wrongCounts = {}) {
  const q = [];
  const types = ["writing", "reading", "meaning", "fill"];
  words.forEach(w => {
    const reps = 1 + Math.min((wrongCounts[w.kanji] || 0), 3);
    const shuffledTypes = shuffle(types);
    for (let i = 0; i < reps; i++) {
      q.push({ word: w, type: shuffledTypes[i % shuffledTypes.length] });
    }
  });
  return shuffle(q);
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function extractTextFromImage(b64) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 800,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: "この画像に書かれている漢字・熟語・ことばのリストをすべてテキストで書き出してください。読み仮名があれば一緒に書いてください。箇条書きで出力してください。" }
      ]}]
    })
  });
  const d = await res.json();
  return d.content.map(b => b.text || "").join("");
}

async function generateQuestions(wordText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 5000,
      messages: [{ role: "user", content: `
小学3〜4年生向けの漢字テスト問題を作成してください。
以下の漢字・熟語リスト：
${wordText}

厳密にこのJSON形式のみで返してください（前後に文字を一切つけないこと）：
{"words":[{"kanji":"漢字","reading":"ひらがな","meaning":"わかりやすい意味説明","example":"例文（漢字部分を__で示す）","wrongMeanings":["誤答1","誤答2","誤答3"],"wrongReadings":["まちがい1","まちがい2","まちがい3"]}]}
・meaning・wrongMeaningsは小学生が理解できる平易な日本語で
・exampleは自然な短い文（__は漢字そのものに置換します）
・最低5問・最大20問
・JSONのみ出力すること` }]
    })
  });
  const d = await res.json();
  const raw = d.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(raw).words;
}

async function checkHandwriting(imgB64, target) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 200,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: imgB64 } },
        { type: "text", text: `この手書き文字の画像を見て、「${target}」と書いてあるか判定してください。JSONのみ返答：{"correct":true/false,"feedback":"ひとこと（ひらがな・漢字のみ・10文字以内）"}` }
      ]}]
    })
  });
  const d = await res.json();
  const raw = d.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ─── DRAWING CANVAS ───────────────────────────────────────────────────────────
function DrawingCanvas({ target, onSubmit }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasStrokes, setHasStrokes] = useState(false);
  const last = useRef(null);

  const initCanvas = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#FFFEF5";
    ctx.fillRect(0, 0, c.width, c.height);
    // grid lines
    ctx.strokeStyle = "rgba(180,160,120,0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(150,0); ctx.lineTo(150,300); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,150); ctx.lineTo(300,150); ctx.stroke();
    ctx.setLineDash([]);
  }, []);

  useEffect(() => { initCanvas(); }, [initCanvas]);

  const getXY = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const sx = 300 / r.width, sy = 300 / r.height;
    const src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - r.left) * sx, y: (src.clientY - r.top) * sy };
  };

  const start = (e) => { e.preventDefault(); setDrawing(true); setHasStrokes(true); last.current = getXY(e); };
  const move = (e) => {
    if (!drawing) return; e.preventDefault();
    const p = getXY(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = "#1C1B2E";
    ctx.lineWidth = 9; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.stroke();
    last.current = p;
  };
  const stop = () => setDrawing(false);
  const clear = () => { initCanvas(); setHasStrokes(false); };
  const submit = () => {
    const data = canvasRef.current.toDataURL("image/png").split(",")[1];
    onSubmit(data);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:14 }}>
      <div style={{ fontSize:13, color:"#9C7B5A", background:"#FFF3DC", padding:"6px 16px", borderRadius:99, fontWeight:700 }}>
        ✏️「{target}」をマスに書こう
      </div>
      <div style={{ position:"relative" }}>
        <canvas ref={canvasRef} width={300} height={300}
          style={{ border:"3px solid #D4B896", borderRadius:18, touchAction:"none", width:"min(280px,78vw)", height:"min(280px,78vw)", display:"block", boxShadow:"0 3px 14px rgba(180,140,80,0.18)" }}
          onMouseDown={start} onMouseMove={move} onMouseUp={stop} onMouseLeave={stop}
          onTouchStart={start} onTouchMove={move} onTouchEnd={stop}
        />
      </div>
      <div style={{ display:"flex", gap:10 }}>
        <button onClick={clear}
          style={{ padding:"11px 22px", borderRadius:11, border:"2px solid #D4B896", background:"white", fontSize:14, cursor:"pointer", fontFamily:"inherit", color:"#9C7B5A", fontWeight:700 }}>
          🗑 消す
        </button>
        <button onClick={submit} disabled={!hasStrokes}
          style={{ padding:"11px 28px", borderRadius:11, border:"none", background: hasStrokes ? "linear-gradient(135deg,#FF6B35,#FF9A5C)" : "#D4C4B0", color:"white", fontSize:15, fontWeight:900, cursor: hasStrokes ? "pointer":"default", fontFamily:"inherit", boxShadow: hasStrokes ? "0 3px 10px rgba(255,107,53,0.35)":"none" }}>
          かくにんする →
        </button>
      </div>
    </div>
  );
}

// ─── STAR BURST (celebration) ─────────────────────────────────────────────────
function Stars() {
  return (
    <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:999 }}>
      {Array.from({length:18}).map((_,i) => (
        <div key={i} style={{
          position:"absolute",
          left: `${5 + Math.random()*90}%`,
          top: `${5 + Math.random()*90}%`,
          fontSize: `${18+Math.random()*22}px`,
          animation: `starPop 0.7s ${i*0.04}s both`,
        }}>
          {["⭐","🌟","✨","🎉","🎊","💫"][i%6]}
        </div>
      ))}
    </div>
  );
}

// ─── UPLOAD SCREEN ────────────────────────────────────────────────────────────
function UploadScreen({ onStart }) {
  const [imgSrc, setImgSrc] = useState(null);
  const [imgB64, setImgB64] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState(""); // "reading" | "making"
  const [err, setErr] = useState("");
  const fileRef = useRef();
  const cameraRef = useRef();

  const handleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setImgSrc(e.target.result);
      setImgB64(e.target.result.split(",")[1]);
      setErr("");
    };
    reader.readAsDataURL(file);
  };

  const handleGo = async () => {
    if (!imgB64) { setErr("画像を選んでください"); return; }
    setLoading(true); setErr("");
    try {
      setStage("reading");
      const text = await extractTextFromImage(imgB64);
      setStage("making");
      const words = await generateQuestions(text);
      onStart(words);
    } catch (e) {
      setErr("うまく読み取れませんでした。もう一度試してね。");
    }
    setLoading(false); setStage("");
  };

  return (
    <div style={{ maxWidth:440, margin:"0 auto" }}>
      {/* header */}
      <div style={{ textAlign:"center", marginBottom:28 }}>
        <div style={{ fontSize:64, lineHeight:1, marginBottom:10, filter:"drop-shadow(0 4px 8px rgba(255,160,0,0.3))" }}>📒</div>
        <h1 style={{ margin:0, fontSize:30, fontWeight:900, color:"#2C1810", letterSpacing:2, fontFamily:"'Kaisei Opti', 'Noto Serif JP', serif" }}>
          かんじマスター
        </h1>
        <p style={{ margin:"8px 0 0", fontSize:14, color:"#9C7B5A" }}>テストのプリントをとって、100点をめざそう！</p>
      </div>

      {/* upload card */}
      <div style={{ background:"white", borderRadius:22, padding:26, boxShadow:"0 6px 28px rgba(180,120,60,0.12)", border:"2px solid #EDD9B8", marginBottom:18 }}>
        <div style={{ fontWeight:800, fontSize:15, color:"#5C3D1E", marginBottom:14, display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ background:"#FFF3DC", borderRadius:8, padding:"2px 10px", fontSize:13, color:"#E07B20" }}>ステップ 1</span>
          プリントの写真をとろう
        </div>

        {/* drop zone */}
        <div
          onClick={() => fileRef.current.click()}
          style={{ border:"3px dashed #D4B896", borderRadius:16, padding:"28px 20px", textAlign:"center", cursor:"pointer", background: imgSrc ? "#FFF8F0" : "#FFFDF7", transition:"all 0.2s", position:"relative", overflow:"hidden" }}
        >
          {imgSrc ? (
            <div>
              <img src={imgSrc} alt="uploaded" style={{ maxWidth:"100%", maxHeight:200, borderRadius:10, objectFit:"contain" }} />
              <div style={{ marginTop:10, fontSize:13, color:"#9C7B5A" }}>✅ 画像がよみこまれました</div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize:48, marginBottom:8 }}>📷</div>
              <div style={{ fontWeight:800, color:"#9C7B5A", fontSize:15 }}>ここをタップして写真を選ぶ</div>
              <div style={{ fontSize:12, color:"#BBA888", marginTop:4 }}>プリント・教科書・ノートOK</div>
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }} onChange={e => handleFile(e.target.files[0])} />

        {/* camera button */}
        <button
          onClick={() => cameraRef.current.click()}
          style={{ width:"100%", marginTop:12, padding:"12px", borderRadius:12, border:"2px solid #D4B896", background:"#FFF8F0", fontSize:14, fontWeight:700, color:"#9C7B5A", cursor:"pointer", fontFamily:"inherit" }}>
          📸 カメラで直接とる
        </button>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display:"none" }} onChange={e => handleFile(e.target.files[0])} />
      </div>

      {err && <div style={{ color:"#E05050", fontSize:13, textAlign:"center", marginBottom:10, background:"#FFF0F0", padding:"8px 16px", borderRadius:10 }}>⚠ {err}</div>}

      {/* start button */}
      <button onClick={handleGo} disabled={loading || !imgB64}
        style={{ width:"100%", padding:"20px", borderRadius:16, border:"none", background: (loading || !imgB64) ? "#D4C4B0" : "linear-gradient(135deg,#FF6B35 0%,#FFAA00 100%)", color:"white", fontSize:20, fontWeight:900, cursor: (loading || !imgB64) ? "default":"pointer", fontFamily:"'Kaisei Opti','Noto Serif JP',serif", letterSpacing:2, boxShadow: imgB64 && !loading ? "0 6px 20px rgba(255,107,53,0.4)":"none", transition:"all 0.3s" }}>
        {loading
          ? stage === "reading" ? "🔍 文字をよみとり中..." : "🤖 もんだいを作成中..."
          : "べんきょうスタート！ 🚀"
        }
      </button>

      {/* feature pills */}
      <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginTop:20, justifyContent:"center" }}>
        {["✏️ 書き取り","📖 読み方","💡 意味えらび","🔤 穴埋め"].map(t => (
          <span key={t} style={{ background:"white", border:"1.5px solid #EDD9B8", borderRadius:99, padding:"5px 14px", fontSize:13, color:"#9C7B5A", fontWeight:600 }}>{t}</span>
        ))}
      </div>
    </div>
  );
}

// ─── QUESTION ────────────────────────────────────────────────────────────────
function QuestionCard({ entry, idx, total, wrongCount, onAnswer }) {
  const { word, type } = entry;
  const [picked, setPicked] = useState(null);
  const [fillVal, setFillVal] = useState("");
  const [hwResult, setHwResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [showCorrect, setShowCorrect] = useState(false);

  const choices = type === "reading"
    ? shuffle([word.reading, ...word.wrongReadings.slice(0,3)])
    : shuffle([word.meaning, ...word.wrongMeanings.slice(0,3)]);

  const finalize = (correct) => {
    setShowCorrect(true);
    setTimeout(() => onAnswer(correct), correct ? 1000 : 1600);
  };

  const pickChoice = (c) => {
    if (picked) return;
    setPicked(c);
    const correct = type === "reading" ? c === word.reading : c === word.meaning;
    finalize(correct);
  };

  const submitFill = () => {
    const v = fillVal.trim();
    const correct = v === word.kanji || v === word.reading;
    finalize(correct);
  };

  const submitHw = async (imgB64) => {
    setChecking(true);
    try {
      const r = await checkHandwriting(imgB64, word.kanji);
      setHwResult(r);
      finalize(r.correct);
    } catch {
      setHwResult({ correct: false, feedback:"よみとれませんでした" });
      finalize(false);
    }
    setChecking(false);
  };

  const pct = idx / total;
  const typeColors = { writing:"#FF6B35", reading:"#2196F3", meaning:"#8E44AD", fill:"#27AE60" };
  const typeIcons = { writing:"✏️", reading:"📖", meaning:"💡", fill:"🔤" };
  const typeNames = { writing:"書き取り", reading:"読み方", meaning:"意味えらび", fill:"穴うめ" };

  return (
    <div style={{ maxWidth:460, margin:"0 auto", width:"100%" }}>
      {/* progress bar */}
      <div style={{ marginBottom:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#9C7B5A", marginBottom:5, fontWeight:600 }}>
          <span>{idx + 1} / {total} もん</span>
          {wrongCount > 0 && <span style={{ color:"#FF6B35" }}>⚡ 苦手 {wrongCount}個</span>}
        </div>
        <div style={{ height:10, background:"#EDD9B8", borderRadius:99, overflow:"hidden" }}>
          <div style={{ height:10, width:`${pct*100}%`, background:`linear-gradient(90deg,${typeColors[type]},${typeColors[type]}CC)`, borderRadius:99, transition:"width 0.5s cubic-bezier(0.34,1.56,0.64,1)" }} />
        </div>
      </div>

      {/* type badge */}
      <div style={{ display:"flex", justifyContent:"center", marginBottom:14 }}>
        <span style={{ background: typeColors[type] + "22", color: typeColors[type], border:`2px solid ${typeColors[type]}44`, padding:"5px 18px", borderRadius:99, fontSize:14, fontWeight:800, letterSpacing:1 }}>
          {typeIcons[type]} {typeNames[type]}
        </span>
      </div>

      {/* card */}
      <div style={{ background:"white", borderRadius:22, padding:"26px 22px", boxShadow:"0 6px 28px rgba(0,0,0,0.09)", border:"2px solid #EDD9B8", marginBottom:16 }}>
        {/* WRITING */}
        {type === "writing" && (
          <div>
            <div style={{ textAlign:"center", marginBottom:20 }}>
              <div style={{ fontSize:13, color:"#9C7B5A", marginBottom:8 }}>この読み方の漢字を書こう</div>
              <div style={{ fontSize:52, fontWeight:900, color:"#FF6B35", fontFamily:"'Kaisei Opti','Noto Serif JP',serif", letterSpacing:6, textShadow:"0 2px 8px rgba(255,107,53,0.2)" }}>
                {word.reading}
              </div>
              <div style={{ fontSize:13, color:"#BBA888", marginTop:6, background:"#FFF8F0", display:"inline-block", padding:"3px 14px", borderRadius:99 }}>
                ヒント：{word.meaning}
              </div>
            </div>
            {checking ? (
              <div style={{ textAlign:"center", padding:28, fontSize:20, color:"#9C7B5A" }}>🤔 チェック中...</div>
            ) : hwResult ? (
              <div style={{ textAlign:"center", padding:20, borderRadius:14, background: hwResult.correct ? "#E8F5E9" : "#FFEBEE", border: `2px solid ${hwResult.correct ? "#81C784" : "#EF9A9A"}` }}>
                <div style={{ fontSize:32 }}>{hwResult.correct ? "⭕" : "❌"}</div>
                <div style={{ fontSize:16, fontWeight:700, color: hwResult.correct ? "#2E7D32" : "#C62828", marginTop:4 }}>{hwResult.feedback}</div>
                {!hwResult.correct && <div style={{ fontSize:18, marginTop:8, fontFamily:"'Noto Serif JP',serif", color:"#555" }}>正解：{word.kanji}</div>}
              </div>
            ) : (
              <DrawingCanvas target={word.kanji} onSubmit={submitHw} />
            )}
          </div>
        )}

        {/* READING */}
        {type === "reading" && (
          <div>
            <div style={{ textAlign:"center", marginBottom:22 }}>
              <div style={{ fontSize:13, color:"#9C7B5A", marginBottom:10 }}>読み方を選ぼう</div>
              <div style={{ fontSize:60, fontWeight:900, color:"#1C1B2E", fontFamily:"'Kaisei Opti','Noto Serif JP',serif", lineHeight:1.1 }}>{word.kanji}</div>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              {choices.map((c, i) => {
                const isRight = c === word.reading;
                const isSel = c === picked;
                let bg = "#FFF8F0", border = "#EDD9B8", color = "#2C1810";
                if (picked) {
                  if (isRight) { bg = "#E8F5E9"; border = "#66BB6A"; color = "#1B5E20"; }
                  else if (isSel) { bg = "#FFEBEE"; border = "#EF5350"; color = "#B71C1C"; }
                }
                return (
                  <button key={i} onClick={() => pickChoice(c)}
                    style={{ padding:"16px 8px", borderRadius:14, border:`2.5px solid ${border}`, background:bg, fontSize:20, fontWeight:700, cursor:"pointer", transition:"all 0.18s", fontFamily:"'Noto Serif JP',serif", color }}>
                    {c}
                    {picked && isRight && " ✓"}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* MEANING */}
        {type === "meaning" && (
          <div>
            <div style={{ textAlign:"center", marginBottom:22 }}>
              <div style={{ fontSize:13, color:"#9C7B5A", marginBottom:10 }}>意味を選ぼう</div>
              <div style={{ fontSize:52, fontWeight:900, color:"#1C1B2E", fontFamily:"'Kaisei Opti','Noto Serif JP',serif" }}>{word.kanji}</div>
              <div style={{ fontSize:15, color:"#9C7B5A", marginTop:4 }}>（{word.reading}）</div>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
              {choices.map((c, i) => {
                const isRight = c === word.meaning;
                const isSel = c === picked;
                let bg = "#FFF8F0", border = "#EDD9B8", color = "#2C1810";
                if (picked) {
                  if (isRight) { bg = "#E8F5E9"; border = "#66BB6A"; color = "#1B5E20"; }
                  else if (isSel) { bg = "#FFEBEE"; border = "#EF5350"; color = "#B71C1C"; }
                }
                return (
                  <button key={i} onClick={() => pickChoice(c)}
                    style={{ padding:"13px 16px", borderRadius:13, border:`2.5px solid ${border}`, background:bg, fontSize:14, textAlign:"left", cursor:"pointer", transition:"all 0.18s", fontFamily:"inherit", color, lineHeight:1.6, fontWeight:500 }}>
                    {c}{picked && isRight && " ✓"}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* FILL */}
        {type === "fill" && (
          <div>
            <div style={{ textAlign:"center", marginBottom:18 }}>
              <div style={{ fontSize:13, color:"#9C7B5A", marginBottom:12 }}>（　）に漢字を入れよう</div>
              <div style={{ fontSize:20, color:"#2C1810", lineHeight:2.2, fontFamily:"'Noto Serif JP',serif", background:"#FFF8F0", padding:"14px 18px", borderRadius:14, border:"2px solid #EDD9B8" }}>
                {word.example?.replace("__", <span key="blank" style={{ background:"#FFE082", padding:"2px 10px", borderRadius:6 }}>（　）</span>) || `（　）＝ ${word.meaning}`}
              </div>
            </div>
            <div style={{ display:"flex", gap:10 }}>
              <input value={fillVal} onChange={e => setFillVal(e.target.value)}
                onKeyDown={e => e.key === "Enter" && fillVal && submitFill()}
                placeholder="漢字を入力"
                style={{ flex:1, padding:"13px 16px", borderRadius:12, border:"2.5px solid #D4B896", fontSize:20, fontFamily:"'Noto Serif JP',serif", outline:"none", background:"#FFFEF5", color:"#2C1810" }}
              />
              <button onClick={submitFill} disabled={!fillVal}
                style={{ padding:"13px 20px", borderRadius:12, border:"none", background: fillVal ? "linear-gradient(135deg,#27AE60,#52D680)" : "#D4C4B0", color:"white", fontSize:16, fontWeight:900, cursor: fillVal ? "pointer":"default", fontFamily:"inherit" }}>
                ✓
              </button>
            </div>
            {showCorrect && fillVal !== word.kanji && (
              <div style={{ marginTop:10, fontSize:14, color:"#888", background:"#F5F5F5", padding:"8px 14px", borderRadius:10 }}>
                正解：<span style={{ fontFamily:"'Noto Serif JP',serif", fontWeight:700, color:"#333", fontSize:18 }}>{word.kanji}</span>（{word.reading}）
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── RESULT ───────────────────────────────────────────────────────────────────
function ResultScreen({ score, total, wrongWords, onRetryWrong, onRetryAll, onNewStudy }) {
  const pct = Math.round(score / total * 100);
  const perfect = score === total;
  const [showStars] = useState(perfect);

  const emoji = perfect ? "🏆" : pct >= 80 ? "😄" : pct >= 60 ? "😅" : "😢";
  const msg = perfect ? "かんぺきです！100点！" : pct >= 80 ? "もうすこし！がんばれ！" : pct >= 60 ? "まだまだのびしろあり！" : "いっしょにがんばろう！";

  return (
    <div style={{ maxWidth:440, margin:"0 auto", textAlign:"center" }}>
      {showStars && <Stars />}
      <style>{`@keyframes starPop{0%{opacity:0;transform:scale(0) rotate(-30deg)}60%{opacity:1;transform:scale(1.3) rotate(10deg)}100%{opacity:0;transform:scale(1) translateY(-40px)}}`}</style>

      <div style={{ fontSize:80, lineHeight:1, marginBottom:8, filter:"drop-shadow(0 4px 12px rgba(255,180,0,0.3))" }}>{emoji}</div>
      <div style={{ fontSize:72, fontWeight:900, color: perfect ? "#FF6B35" : "#2C1810", fontFamily:"'Kaisei Opti','Noto Serif JP',serif", lineHeight:1 }}>{pct}<span style={{ fontSize:28 }}>点</span></div>
      <div style={{ fontSize:15, color:"#9C7B5A", margin:"6px 0 4px" }}>{total}問中 {score}問 正解</div>
      <div style={{ fontSize:16, fontWeight:700, color: perfect ? "#FF6B35" : "#5C3D1E", marginBottom:28 }}>{msg}</div>

      {perfect && (
        <div style={{ background:"linear-gradient(135deg,#FFF3DC,#FFE0A0)", border:"2.5px solid #FFCC44", borderRadius:18, padding:"20px 24px", marginBottom:28 }}>
          <div style={{ fontSize:20, fontWeight:900, color:"#D97706" }}>🌟 テスト範囲をコンプリート！</div>
          <div style={{ fontSize:13, color:"#B45309", marginTop:4 }}>この調子でテスト本番もがんばって！</div>
        </div>
      )}

      {!perfect && wrongWords.length > 0 && (
        <div style={{ background:"white", border:"2px solid #EDD9B8", borderRadius:18, padding:"18px 20px", marginBottom:22, textAlign:"left" }}>
          <div style={{ fontWeight:800, color:"#C0392B", marginBottom:10, fontSize:14 }}>❌ まちがえた言葉（{wrongWords.length}個）</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
            {wrongWords.map((w, i) => (
              <span key={i} style={{ background:"#FFEBEE", border:"2px solid #FFCDD2", padding:"4px 14px", borderRadius:99, fontSize:17, fontFamily:"'Noto Serif JP',serif", color:"#C62828", fontWeight:700 }}>
                {w.kanji}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {!perfect && wrongWords.length > 0 && (
          <button onClick={onRetryWrong}
            style={{ padding:"18px", borderRadius:14, border:"none", background:"linear-gradient(135deg,#FF6B35,#FFAA00)", color:"white", fontSize:17, fontWeight:900, cursor:"pointer", fontFamily:"'Kaisei Opti','Noto Serif JP',serif", boxShadow:"0 4px 16px rgba(255,107,53,0.35)", letterSpacing:1 }}>
            ⚡ まちがいだけやり直す！
          </button>
        )}
        <button onClick={onRetryAll}
          style={{ padding:"16px", borderRadius:14, border:"2.5px solid #FF6B35", background:"white", color:"#FF6B35", fontSize:15, fontWeight:800, cursor:"pointer", fontFamily:"inherit" }}>
          🔄 全問もう一度やる
        </button>
        <button onClick={onNewStudy}
          style={{ padding:"14px", borderRadius:14, border:"2px solid #EDD9B8", background:"white", color:"#9C7B5A", fontSize:14, cursor:"pointer", fontFamily:"inherit" }}>
          📷 新しいプリントで勉強する
        </button>
      </div>
    </div>
  );
}

// ─── ROOT APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("upload"); // upload | quiz | result
  const [words, setWords] = useState([]);
  const [queue, setQueue] = useState([]);
  const [qIdx, setQIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [wrongCounts, setWrongCounts] = useState({});
  const [wrongWords, setWrongWords] = useState([]);

  const startQuiz = (w, wc = {}) => {
    const q = buildQueue(w, wc);
    setWords(w); setQueue(q); setQIdx(0); setScore(0); setWrongWords([]);
    setScreen("quiz");
  };

  const handleAnswer = (correct) => {
    const cur = queue[qIdx];
    if (!correct) {
      const newWC = { ...wrongCounts, [cur.word.kanji]: (wrongCounts[cur.word.kanji] || 0) + 1 };
      setWrongCounts(newWC);
      setWrongWords(prev => prev.find(x => x.kanji === cur.word.kanji) ? prev : [...prev, cur.word]);
    } else {
      setScore(s => s + 1);
    }
    if (qIdx + 1 >= queue.length) setScreen("result");
    else setQIdx(i => i + 1);
  };

  return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(160deg,#FFF8EE 0%,#FFE8C0 50%,#FFF0D8 100%)", padding:"22px 14px 56px", fontFamily:"'Hiragino Sans','Yu Gothic','Meiryo',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Kaisei+Opti:wght@400;700;800&family=Noto+Serif+JP:wght@400;700;900&display=swap');
        * { box-sizing: border-box; }
        button:active { transform: scale(0.97); }
        @keyframes fadeIn { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:translateY(0); } }
        .qa-card { animation: fadeIn 0.35s cubic-bezier(0.34,1.56,0.64,1) both; }
      `}</style>

      {screen === "upload" && (
        <div className="qa-card">
          <UploadScreen onStart={w => { setWrongCounts({}); startQuiz(w); }} />
        </div>
      )}

      {screen === "quiz" && queue[qIdx] && (
        <div className="qa-card" key={qIdx}>
          <QuestionCard
            entry={queue[qIdx]}
            idx={qIdx}
            total={queue.length}
            wrongCount={Object.keys(wrongCounts).length}
            onAnswer={handleAnswer}
          />
        </div>
      )}

      {screen === "result" && (
        <div className="qa-card">
          <ResultScreen
            score={score}
            total={queue.length}
            wrongWords={wrongWords}
            onRetryWrong={() => startQuiz(wrongWords.length > 0 ? wrongWords : words, wrongCounts)}
            onRetryAll={() => startQuiz(words, wrongCounts)}
            onNewStudy={() => { setWrongCounts({}); setScreen("upload"); }}
          />
        </div>
      )}
    </div>
  );
}
