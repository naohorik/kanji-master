import { useState, useRef, useEffect, useCallback } from "react";

const API_HEADERS = {
  "Content-Type": "application/json",
  "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
};

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
  words.forEach(w => {
    const extra = Math.min(wrongCounts[w.kanji] || 0, 3);
    if (w.meaning) {
      q.push({ word: w, type: "meaning" });
      for (let i = 0; i < extra; i++) q.push({ word: w, type: "meaning" });
    } else if (w.kanyoku) {
      const t = Math.random() < 0.5 ? "kanyoku_meaning" : "kanyoku_fill";
      q.push({ word: w, type: t });
      for (let i = 0; i < extra; i++) q.push({ word: w, type: t });
    } else {
      q.push({ word: w, type: "writing" });
      q.push({ word: w, type: "reading" });
      if (w.yoji) q.push({ word: w, type: "yoji" });
      for (let i = 0; i < extra; i++) {
        q.push({ word: w, type: i % 2 === 0 ? "writing" : "reading" });
      }
    }
  });
  return shuffle(q);
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function extractTextFromImage(b64) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: API_HEADERS,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 1200,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: "この画像に書かれているテスト範囲の漢字・熟語・和語・慣用句をすべて書き出してください。読み仮名があれば一緒に。箇条書きで出力してください。" }
      ]}]
    })
  });
  const d = await res.json();
  return d.content.map(b => b.text || "").join("");
}

async function generateQuestions(wordText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: API_HEADERS,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 6000,
      messages: [{ role: "user", content: `みろく国語塾 中級レベルの問題を作成してください。
以下のテキストから語句を抽出してください：
${wordText}

厳密にこのJSON形式のみで返してください（前後に文字を一切つけないこと）：
{"words":[{
  "kanji":"漢字・熟語・和語・慣用句",
  "reading":"ひらがなの読み方",
  "wrongReadings":["まちがいよみ1","まちがいよみ2","まちがいよみ3"],
  "yoji":null,
  "meaning":null,
  "kanyoku":null
}]}

各フィールドのルール：
・漢字・熟語：reading と wrongReadings を設定。yoji・meaning・kanyoku は null
・四字熟語：yoji に {"full":"一石二鳥","blank":2,"answer":"石","wrongAnswers":["木","金","土"]} を設定（blank は1〜4の位置）
・和語（ひらがなの言葉）：meaning に {"text":"言葉の意味説明","wrongMeanings":["誤答1","誤答2","誤答3"]} を設定
・慣用句：kanyoku に {"phrase":"羽をのばす","blank":"羽","answer":"羽","wrongAnswers":["根","虫","猫"],"meaning":"のびのびと自由にすること"} を設定
・最低5問・最大25問
・JSONのみ出力` }]
    })
  });
  const d = await res.json();
  const raw = d.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(raw).words;
}

async function checkHandwriting(imgB64, target) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: API_HEADERS,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 200,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: imgB64 } },
        { type: "text", text: `この手書き文字の画像を見て、「${target}」と書いてあるか判定してください。JSONのみ返答：{"correct":true/false,"feedback":"ひとこと（ひらがな・漢字のみ・12文字以内）"}` }
      ]}]
    })
  });
  const d = await res.json();
  const raw = d.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ─── DRAWING CANVAS（文字数に応じたマス） ────────────────────────────────────
function DrawingCanvas({ target, onSubmit }) {
  const charCount = [...target].length; // 文字数（絵文字対応）
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasStrokes, setHasStrokes] = useState(false);
  const last = useRef(null);

  // キャンバスサイズ：1文字=600px幅、2文字=1200px幅（内部解像度）
  const CELL = 600;
  const W = CELL * charCount;
  const H = CELL;

  const initCanvas = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#FFFEF5";
    ctx.fillRect(0, 0, W, H);
    // 各マスの十字ガイドと枠線
    for (let i = 0; i < charCount; i++) {
      const x = i * CELL;
      ctx.strokeStyle = "rgba(180,160,120,0.25)";
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 12]);
      ctx.beginPath(); ctx.moveTo(x + CELL/2, 0); ctx.lineTo(x + CELL/2, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, H/2); ctx.lineTo(x + CELL, H/2); ctx.stroke();
      ctx.setLineDash([]);
      // マス枠
      if (i > 0) {
        ctx.strokeStyle = "rgba(180,160,120,0.5)";
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
    }
  }, [W, H, charCount, CELL]);

  useEffect(() => { initCanvas(); }, [initCanvas]);

  const getXY = (e) => {
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    const scaleX = W / r.width;
    const scaleY = H / r.height;
    const src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - r.left) * scaleX, y: (src.clientY - r.top) * scaleY };
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
    ctx.lineWidth = 16; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.stroke();
    last.current = p;
  };
  const stop = () => setDrawing(false);
  const clear = () => { initCanvas(); setHasStrokes(false); };
  const submit = () => onSubmit(canvasRef.current.toDataURL("image/png").split(",")[1]);

  // 表示サイズ：画面幅に収める。1文字なら正方形大きく、複数文字なら横長
  const displayH = "min(72vw, 420px)";
  const displayW = charCount === 1 ? displayH : `min(${charCount * 72}vw, ${charCount * 420}px)`;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      {/* マスラベル */}
      <div style={{ display: "flex", gap: 4, alignSelf: "stretch", justifyContent: "center" }}>
        {[...target].map((ch, i) => (
          <div key={i} style={{ flex: 1, maxWidth: 420, textAlign: "center", fontSize: 13, color: "#BBA888", fontWeight: 600 }}>マス{i+1}</div>
        ))}
      </div>
      <canvas ref={canvasRef} width={W} height={H}
        style={{ border: "3px solid #D4B896", borderRadius: 20, touchAction: "none",
          width: displayW, height: displayH,
          display: "block", boxShadow: "0 4px 20px rgba(180,140,80,0.25)", background: "#FFFEF5",
          maxWidth: "96vw" }}
        onMouseDown={start} onMouseMove={move} onMouseUp={stop} onMouseLeave={stop}
        onTouchStart={start} onTouchMove={move} onTouchEnd={stop}
      />
      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={clear}
          style={{ padding: "13px 26px", borderRadius: 12, border: "2px solid #D4B896", background: "white", fontSize: 16, cursor: "pointer", fontFamily: "inherit", color: "#9C7B5A", fontWeight: 700 }}>
          🗑 消す
        </button>
        <button onClick={submit} disabled={!hasStrokes}
          style={{ padding: "13px 34px", borderRadius: 12, border: "none", background: hasStrokes ? "linear-gradient(135deg,#FF6B35,#FF9A5C)" : "#D4C4B0", color: "white", fontSize: 17, fontWeight: 900, cursor: hasStrokes ? "pointer" : "default", fontFamily: "inherit", boxShadow: hasStrokes ? "0 4px 14px rgba(255,107,53,0.4)" : "none" }}>
          かくにん →
        </button>
      </div>
    </div>
  );
}

// ─── STARS ────────────────────────────────────────────────────────────────────
function Stars() {
  const items = useRef(Array.from({ length: 20 }, () => ({
    left: `${5 + Math.random() * 90}%`, top: `${5 + Math.random() * 90}%`,
    size: `${20 + Math.random() * 24}px`, delay: `${Math.random() * 0.5}s`,
    icon: ["⭐","🌟","✨","🎉","🎊","💫"][Math.floor(Math.random() * 6)]
  })));
  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 999 }}>
      {items.current.map((s, i) => (
        <div key={i} style={{ position: "absolute", left: s.left, top: s.top, fontSize: s.size, animation: `starPop 0.8s ${s.delay} both` }}>{s.icon}</div>
      ))}
    </div>
  );
}

// ─── UPLOAD SCREEN ────────────────────────────────────────────────────────────
function UploadScreen({ onWordsReady }) {
  const [tab, setTab] = useState("photo");
  const [imgs, setImgs] = useState([null, null]);
  const [textInput, setTextInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("");
  const [err, setErr] = useState("");
  const fileRef0 = useRef(); const fileRef1 = useRef();

  const canStart = tab === "photo" ? imgs.some(i => i !== null) : textInput.trim().length > 0;

  const handleFile = (file, idx) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const newImgs = [...imgs];
      newImgs[idx] = { src: e.target.result, b64: e.target.result.split(",")[1] };
      setImgs(newImgs); setErr("");
    };
    reader.readAsDataURL(file);
  };

  const handleGo = async () => {
    if (!canStart) return;
    setLoading(true); setErr("");
    try {
      let text = textInput;
      if (tab === "photo") {
        setStage("reading");
        const loaded = imgs.filter(i => i !== null);
        const texts = await Promise.all(loaded.map(i => extractTextFromImage(i.b64)));
        text = texts.join("\n");
      }
      setStage("making");
      const words = await generateQuestions(text);
      if (!words || words.length === 0) throw new Error("empty");
      onWordsReady(words); // → 確認画面へ
    } catch (e) {
      setErr("もんだいを作れませんでした。もう一度試してね。");
    }
    setLoading(false); setStage("");
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 22 }}>
        <div style={{ fontSize: 58, lineHeight: 1, marginBottom: 8 }}>📝</div>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 900, color: "#2C1810", letterSpacing: 2, fontFamily: "'Kaisei Opti','Noto Serif JP',serif" }}>かんじマスター</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "#9C7B5A" }}>読み方・書き取りで100点をめざそう！</p>
      </div>

      <div style={{ display: "flex", background: "#EDD9B8", borderRadius: 14, padding: 4, marginBottom: 14, gap: 4 }}>
        {[["photo","📷 写真でよみとる"],["text","✏️ 手入力する"]].map(([key,label]) => (
          <button key={key} onClick={() => { setTab(key); setErr(""); }}
            style={{ flex:1, padding:"11px 8px", borderRadius:11, border:"none", background: tab===key?"white":"transparent", color: tab===key?"#E07B20":"#9C7B5A", fontWeight:800, fontSize:14, cursor:"pointer", fontFamily:"inherit", boxShadow: tab===key?"0 2px 8px rgba(0,0,0,0.1)":"none", transition:"all 0.2s" }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ background:"white", borderRadius:20, padding:22, boxShadow:"0 6px 24px rgba(180,120,60,0.12)", border:"2px solid #EDD9B8", marginBottom:14 }}>
        {tab === "photo" ? (
          <div>
            <div style={{ fontWeight:800, fontSize:14, color:"#5C3D1E", marginBottom:4 }}>プリント2枚の写真をとろう</div>
            <div style={{ fontSize:12, color:"#9C7B5A", marginBottom:12 }}>1枚でもOK！2枚まとめて問題を作るよ</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              {[[fileRef0,0,"1枚め（必須）"],[fileRef1,1,"2枚め（任意）"]].map(([ref,idx,label]) => (
                <div key={idx}>
                  <div style={{ fontSize:12, fontWeight:700, color:"#9C7B5A", marginBottom:5, textAlign:"center" }}>{label}</div>
                  <div onClick={() => ref.current.click()}
                    style={{ border:`3px dashed ${imgs[idx]?"#81C784":"#D4B896"}`, borderRadius:14, padding:"16px 10px", textAlign:"center", cursor:"pointer", background: imgs[idx]?"#F1F8F1":"#FFFDF7", minHeight:110, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
                    {imgs[idx] ? (
                      <div><img src={imgs[idx].src} alt="" style={{ maxWidth:"100%", maxHeight:80, borderRadius:8, objectFit:"contain" }} />
                        <div style={{ marginTop:6, fontSize:11, color:"#4CAF50", fontWeight:700 }}>✅ よみこみ済み</div></div>
                    ) : (
                      <div><div style={{ fontSize:32, marginBottom:4 }}>📷</div>
                        <div style={{ fontSize:12, color:"#9C7B5A", fontWeight:700 }}>タップして選ぶ</div></div>
                    )}
                  </div>
                  <input ref={ref} type="file" accept="image/*" style={{ display:"none" }} onChange={e => handleFile(e.target.files[0], idx)} />
                </div>
              ))}
            </div>
            {imgs.some(i=>i!==null) && (
              <button onClick={() => setImgs([null,null])}
                style={{ width:"100%", marginTop:10, padding:"8px", borderRadius:10, border:"1.5px solid #EDD9B8", background:"white", fontSize:13, color:"#9C7B5A", cursor:"pointer", fontFamily:"inherit" }}>
                🗑 リセット
              </button>
            )}
          </div>
        ) : (
          <div>
            <div style={{ fontWeight:800, fontSize:14, color:"#5C3D1E", marginBottom:6 }}>テストに出る漢字を入力しよう</div>
            <div style={{ fontSize:12, color:"#9C7B5A", marginBottom:10 }}>スペース・読点・改行で区切ってね（5個以上）</div>
            <textarea value={textInput} onChange={e => setTextInput(e.target.value)}
              placeholder={"例：\n友達、協力、努力\n正直（しょうじき）\n羽をのばす、根に持つ"}
              style={{ width:"100%", minHeight:160, padding:"14px", borderRadius:14, border:"2.5px solid #D4B896", fontSize:16, fontFamily:"'Noto Serif JP',serif", outline:"none", background:"#FFFEF5", color:"#2C1810", lineHeight:1.9, resize:"vertical", boxSizing:"border-box" }}
            />
          </div>
        )}
      </div>

      {err && <div style={{ color:"#E05050", fontSize:13, textAlign:"center", marginBottom:10, background:"#FFF0F0", padding:"10px 16px", borderRadius:10 }}>⚠ {err}</div>}

      <button onClick={handleGo} disabled={loading||!canStart}
        style={{ width:"100%", padding:"20px", borderRadius:16, border:"none", background:(loading||!canStart)?"#D4C4B0":"linear-gradient(135deg,#FF6B35,#FFAA00)", color:"white", fontSize:20, fontWeight:900, cursor:(loading||!canStart)?"default":"pointer", fontFamily:"'Kaisei Opti','Noto Serif JP',serif", letterSpacing:2, boxShadow: canStart&&!loading?"0 6px 20px rgba(255,107,53,0.4)":"none", transition:"all 0.3s" }}>
        {loading ? (stage==="reading"?"🔍 よみとり中...":"🤖 もんだいを作成中...") : "つぎへ →"}
      </button>
    </div>
  );
}

// ─── 確認・編集画面 ───────────────────────────────────────────────────────────
function ConfirmScreen({ words, onStart, onBack }) {
  const [list, setList] = useState(words);
  const [newWord, setNewWord] = useState("");

  const remove = (idx) => setList(l => l.filter((_, i) => i !== idx));

  const add = async () => {
    const w = newWord.trim();
    if (!w) return;
    // シンプルに追加（読みはAIで後で補完）
    setList(l => [...l, { kanji: w, reading: "（よみとり中）", wrongReadings: [], yoji: null, meaning: null, kanyoku: null }]);
    setNewWord("");
  };

  const typeLabel = (w) => {
    if (w.meaning) return "📗 和語";
    if (w.kanyoku) return "💬 慣用句";
    if (w.yoji) return "🀄 四字熟語";
    return "✏️ 漢字";
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: "#9C7B5A", marginBottom: 6 }}>読み取り完了！</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: "#2C1810", fontFamily: "'Kaisei Opti','Noto Serif JP',serif" }}>
          問題範囲を確認しよう
        </h2>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "#9C7B5A" }}>タップで削除・追加もできるよ</p>
      </div>

      {/* 語句リスト */}
      <div style={{ background: "white", borderRadius: 20, padding: "16px 14px", boxShadow: "0 4px 18px rgba(180,120,60,0.1)", border: "2px solid #EDD9B8", marginBottom: 14, maxHeight: "50vh", overflowY: "auto" }}>
        {list.map((w, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 8px", borderBottom: i < list.length - 1 ? "1px solid #F5ECD8" : "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, background: "#FFF3DC", color: "#E07B20", padding: "2px 8px", borderRadius: 99, fontWeight: 700, whiteSpace: "nowrap" }}>{typeLabel(w)}</span>
              <span style={{ fontSize: 18, fontFamily: "'Noto Serif JP',serif", fontWeight: 700, color: "#2C1810" }}>{w.kanji}</span>
              <span style={{ fontSize: 12, color: "#9C7B5A" }}>{w.reading !== "（よみとり中）" ? w.reading : ""}</span>
            </div>
            <button onClick={() => remove(i)}
              style={{ padding: "4px 10px", borderRadius: 8, border: "1.5px solid #FFCDD2", background: "#FFF5F5", color: "#E57373", fontSize: 13, cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
              削除
            </button>
          </div>
        ))}
        {list.length === 0 && (
          <div style={{ textAlign: "center", padding: 20, color: "#9C7B5A", fontSize: 14 }}>語句がありません</div>
        )}
      </div>

      {/* 追加フォーム */}
      <div style={{ background: "white", borderRadius: 16, padding: "14px 16px", boxShadow: "0 4px 14px rgba(180,120,60,0.08)", border: "2px solid #EDD9B8", marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#5C3D1E", marginBottom: 8 }}>➕ 語句を追加する</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={newWord} onChange={e => setNewWord(e.target.value)}
            onKeyDown={e => e.key === "Enter" && newWord && add()}
            placeholder="漢字・語句を入力"
            style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: "2px solid #D4B896", fontSize: 16, fontFamily: "'Noto Serif JP',serif", outline: "none", background: "#FFFEF5", color: "#2C1810" }}
          />
          <button onClick={add} disabled={!newWord.trim()}
            style={{ padding: "10px 18px", borderRadius: 10, border: "none", background: newWord.trim() ? "#FF6B35" : "#D4C4B0", color: "white", fontSize: 15, fontWeight: 900, cursor: newWord.trim() ? "pointer" : "default", fontFamily: "inherit" }}>
            追加
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={onBack}
          style={{ flex: 1, padding: "14px", borderRadius: 14, border: "2px solid #EDD9B8", background: "white", color: "#9C7B5A", fontSize: 14, cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
          ← もどる
        </button>
        <button onClick={() => onStart(list)} disabled={list.length === 0}
          style={{ flex: 2, padding: "16px", borderRadius: 14, border: "none", background: list.length > 0 ? "linear-gradient(135deg,#FF6B35,#FFAA00)" : "#D4C4B0", color: "white", fontSize: 18, fontWeight: 900, cursor: list.length > 0 ? "pointer" : "default", fontFamily: "'Kaisei Opti','Noto Serif JP',serif", boxShadow: list.length > 0 ? "0 4px 16px rgba(255,107,53,0.35)" : "none" }}>
          べんきょうスタート！ 🚀
        </button>
      </div>

      <div style={{ textAlign: "center", marginTop: 10, fontSize: 12, color: "#BBA888" }}>{list.length}語句 → 約{list.length * 2}問</div>
    </div>
  );
}

// ─── QUESTION CARD ────────────────────────────────────────────────────────────
function QuestionCard({ entry, idx, total, wrongCount, onAnswer }) {
  const { word, type } = entry;
  const [picked, setPicked] = useState(null);
  const [hwResult, setHwResult] = useState(null);
  const [checking, setChecking] = useState(false);

  const isWriting = type === "writing";
  const isYoji = type === "yoji";
  const isMeaning = type === "meaning";
  const isKanyokuMeaning = type === "kanyoku_meaning";
  const isKanyokuFill = type === "kanyoku_fill";
  const color = isWriting ? "#FF6B35" : isYoji ? "#8E44AD" : (isMeaning||isKanyokuMeaning||isKanyokuFill) ? "#27AE60" : "#2196F3";
  const typeLabel = isWriting ? "✏️ 書き取り" : isYoji ? "🀄 四字熟語" : isMeaning ? "📗 意味えらび" : isKanyokuMeaning ? "💬 慣用句の意味" : isKanyokuFill ? "💬 慣用句の穴埋め" : "📖 読み方";

  const readingChoices = type === "reading" ? shuffle([word.reading, ...(word.wrongReadings||[]).slice(0,3)]) : [];
  const meaningChoices = isMeaning && word.meaning ? shuffle([word.meaning.text, ...(word.meaning.wrongMeanings||[]).slice(0,3)]) : [];
  const kanyokuMeaningChoices = isKanyokuMeaning && word.kanyoku ? shuffle([word.kanyoku.meaning, ...(word.kanyoku.wrongAnswers||[]).slice(0,3).map(a => a + "に関係すること")]) : [];
  const kanyokuFillChoices = isKanyokuFill && word.kanyoku ? shuffle([word.kanyoku.answer, ...(word.kanyoku.wrongAnswers||[]).slice(0,3)]) : [];
  const yojiChoices = isYoji && word.yoji ? shuffle([word.yoji.answer, ...(word.yoji.wrongAnswers||[]).slice(0,3)]) : [];

  const finalize = (correct) => setTimeout(() => onAnswer(correct), correct ? 900 : 1800);

  const pick = (c, correctVal) => {
    if (picked) return;
    setPicked(c);
    finalize(c === correctVal);
  };

  const submitHw = async (imgB64) => {
    setChecking(true);
    try {
      const r = await checkHandwriting(imgB64, word.kanji);
      setHwResult(r);
      finalize(r.correct);
    } catch {
      setHwResult({ correct: false, feedback: "よみとれませんでした" });
      finalize(false);
    }
    setChecking(false);
  };

  const choiceBtn = (c, correctVal, choices, size = 22) => {
    const isRight = c === correctVal;
    const isSel = c === picked;
    let bg = "#FFF8F0", border = "#EDD9B8", col = "#2C1810";
    if (picked) {
      if (isRight) { bg = "#E8F5E9"; border = "#66BB6A"; col = "#1B5E20"; }
      else if (isSel) { bg = "#FFEBEE"; border = "#EF5350"; col = "#B71C1C"; }
    }
    return (
      <button key={c} onClick={() => pick(c, correctVal)}
        style={{ padding: size > 18 ? "16px 8px" : "13px 14px", borderRadius: 13, border: `2.5px solid ${border}`, background: bg, fontSize: size, textAlign: "center", cursor: picked ? "default" : "pointer", transition: "all 0.18s", fontFamily: size > 18 ? "'Noto Serif JP',serif" : "inherit", color: col, lineHeight: 1.5, fontWeight: size > 18 ? 700 : 500 }}>
        {c}{picked && isRight && " ✓"}
      </button>
    );
  };

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", width: "100%" }}>
      {/* progress */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9C7B5A", marginBottom: 5, fontWeight: 600 }}>
          <span>{idx + 1} / {total} もん</span>
          {wrongCount > 0 && <span style={{ color: "#FF6B35" }}>⚡ 苦手 {wrongCount}個</span>}
        </div>
        <div style={{ height: 10, background: "#EDD9B8", borderRadius: 99, overflow: "hidden" }}>
          <div style={{ height: 10, width: `${(idx/total)*100}%`, background: `linear-gradient(90deg,${color},${color}BB)`, borderRadius: 99, transition: "width 0.5s cubic-bezier(0.34,1.56,0.64,1)" }} />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
        <span style={{ background: color+"18", color, border: `2px solid ${color}44`, padding: "6px 22px", borderRadius: 99, fontSize: 14, fontWeight: 900 }}>{typeLabel}</span>
      </div>

      <div style={{ background: "white", borderRadius: 22, padding: "24px 20px", boxShadow: "0 6px 28px rgba(0,0,0,0.09)", border: `2px solid ${color}33` }}>

        {/* ── 書き取り ── */}
        {isWriting && (
          <div>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 13, color: "#9C7B5A", marginBottom: 10 }}>この読み方の漢字を書こう</div>
              <div style={{ fontSize: 52, fontWeight: 900, color: "#FF6B35", fontFamily: "'Kaisei Opti','Noto Serif JP',serif", letterSpacing: 6, lineHeight: 1.2 }}>{word.reading}</div>
            </div>
            {checking ? (
              <div style={{ textAlign: "center", padding: 32, fontSize: 20, color: "#9C7B5A" }}>🤔 チェック中...</div>
            ) : hwResult ? (
              <div style={{ textAlign: "center", padding: "22px", borderRadius: 16, background: hwResult.correct ? "#E8F5E9" : "#FFEBEE", border: `2px solid ${hwResult.correct ? "#81C784" : "#EF9A9A"}` }}>
                <div style={{ fontSize: 40 }}>{hwResult.correct ? "⭕" : "❌"}</div>
                <div style={{ fontSize: 17, fontWeight: 800, color: hwResult.correct ? "#2E7D32" : "#C62828", marginTop: 6 }}>{hwResult.feedback}</div>
                {!hwResult.correct && <div style={{ marginTop: 12, fontSize: 14, color: "#888" }}>正解：<span style={{ fontFamily: "'Noto Serif JP',serif", fontSize: 28, fontWeight: 900, color: "#333" }}>{word.kanji}</span></div>}
              </div>
            ) : (
              <DrawingCanvas target={word.kanji} onSubmit={submitHw} />
            )}
          </div>
        )}

        {/* ── 読み方 ── */}
        {type === "reading" && (
          <div>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div style={{ fontSize: 13, color: "#9C7B5A", marginBottom: 12 }}>読み方を選ぼう</div>
              <div style={{ fontSize: 60, fontWeight: 900, color: "#1C1B2E", fontFamily: "'Kaisei Opti','Noto Serif JP',serif", lineHeight: 1.1 }}>{word.kanji}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {readingChoices.map(c => choiceBtn(c, word.reading, readingChoices, 22))}
            </div>
            {picked && picked !== word.reading && <div style={{ marginTop: 12, textAlign: "center", fontSize: 14, color: "#888" }}>正解：<span style={{ fontFamily: "'Noto Serif JP',serif", fontSize: 20, fontWeight: 900, color: "#333" }}>{word.reading}</span></div>}
          </div>
        )}

        {/* ── 四字熟語 ── */}
        {isYoji && word.yoji && (
          <div>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 13, color: "#9C7B5A", marginBottom: 14 }}>□に入る漢字を選ぼう</div>
              <div style={{ display: "flex", justifyContent: "center", gap: 6 }}>
                {word.yoji.full.split("").map((ch, i) => {
                  const isBlank = i + 1 === word.yoji.blank;
                  const showPicked = isBlank && picked;
                  const correct = picked === word.yoji.answer;
                  return (
                    <span key={i} style={{ display:"inline-flex", width:56, height:64, alignItems:"center", justifyContent:"center", fontSize:36, fontWeight:900, fontFamily:"'Kaisei Opti','Noto Serif JP',serif",
                      background: isBlank ? (showPicked ? (correct?"#E8F5E9":"#FFEBEE") : "#FFF3DC") : "transparent",
                      color: isBlank ? (showPicked ? (correct?"#2E7D32":"#C62828") : "#E07B20") : "#1C1B2E",
                      borderRadius: 10, border: isBlank ? `2.5px solid ${showPicked?(correct?"#81C784":"#EF9A9A"):"#FFCC44"}` : "none" }}>
                      {isBlank && picked ? word.yoji.answer : isBlank ? "□" : ch}
                    </span>
                  );
                })}
              </div>
              {picked && <div style={{ marginTop: 12, fontSize: 14, color: picked===word.yoji.answer?"#2E7D32":"#888" }}>{picked===word.yoji.answer?"🎉 正解！":`正解：${word.yoji.answer}`}</div>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {yojiChoices.map(c => choiceBtn(c, word.yoji.answer, yojiChoices, 32))}
            </div>
          </div>
        )}

        {/* ── 意味えらび（和語） ── */}
        {isMeaning && word.meaning && (
          <div>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 13, color: "#9C7B5A", marginBottom: 10 }}>意味を選ぼう</div>
              <div style={{ fontSize: 34, fontWeight: 900, color: "#1C1B2E", fontFamily: "'Noto Serif JP',serif" }}>{word.kanji}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {meaningChoices.map(c => choiceBtn(c, word.meaning.text, meaningChoices, 14))}
            </div>
            {picked && picked !== word.meaning.text && <div style={{ marginTop: 10, fontSize: 13, color: "#888", background: "#F5F5F5", padding: "8px 14px", borderRadius: 10 }}>正解：{word.meaning.text}</div>}
          </div>
        )}

        {/* ── 慣用句の意味 ── */}
        {isKanyokuMeaning && word.kanyoku && (
          <div>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 13, color: "#9C7B5A", marginBottom: 10 }}>慣用句の意味を選ぼう</div>
              <div style={{ fontSize: 24, fontWeight: 900, color: "#27AE60", fontFamily: "'Noto Serif JP',serif", background: "#F0FFF4", padding: "12px 16px", borderRadius: 12, border: "2px solid #A8D5B5" }}>「{word.kanyoku.phrase}」</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[word.kanyoku.meaning, ...(word.kanyoku.wrongAnswers||[]).slice(0,3).map(a=>`${a}に関係すること`)].map((c,i,arr) => {
                const shuffled = i===0 ? shuffle(arr) : null;
                return null;
              })}
              {shuffle([word.kanyoku.meaning, ...(word.kanyoku.wrongAnswers||[]).slice(0,3).map(a=>`「${a}」に関係すること`)]).map(c => choiceBtn(c, word.kanyoku.meaning, [], 14))}
            </div>
            {picked && picked !== word.kanyoku.meaning && <div style={{ marginTop: 10, fontSize: 13, color: "#888", background: "#F5F5F5", padding: "8px 14px", borderRadius: 10 }}>正解：{word.kanyoku.meaning}</div>}
          </div>
        )}

        {/* ── 慣用句の穴埋め ── */}
        {isKanyokuFill && word.kanyoku && (
          <div>
            <div style={{ textAlign: "center", marginBottom: 18 }}>
              <div style={{ fontSize: 13, color: "#9C7B5A", marginBottom: 10 }}>（　）に入る言葉を選ぼう</div>
              <div style={{ fontSize: 22, color: "#2C1810", fontFamily: "'Noto Serif JP',serif", background: "#F0FFF4", padding: "14px 16px", borderRadius: 12, border: "2px solid #A8D5B5", lineHeight: 2 }}>
                {word.kanyoku.phrase.replace(word.kanyoku.blank, "（　）")}
              </div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>意味：{word.kanyoku.meaning}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {kanyokuFillChoices.map(c => choiceBtn(c, word.kanyoku.answer, kanyokuFillChoices, 20))}
            </div>
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
  const emoji = perfect ? "🏆" : pct >= 80 ? "😄" : pct >= 60 ? "😅" : "😢";
  const msg = perfect ? "かんぺきです！100点！" : pct >= 80 ? "あともう少し！" : pct >= 60 ? "のびしろあり！" : "いっしょにがんばろう！";

  return (
    <div style={{ maxWidth: 440, margin: "0 auto", textAlign: "center" }}>
      {perfect && <Stars />}
      <div style={{ fontSize: 80, lineHeight: 1, marginBottom: 8 }}>{emoji}</div>
      <div style={{ fontSize: 72, fontWeight: 900, color: perfect?"#FF6B35":"#2C1810", fontFamily: "'Kaisei Opti','Noto Serif JP',serif", lineHeight: 1 }}>
        {pct}<span style={{ fontSize: 28 }}>点</span>
      </div>
      <div style={{ fontSize: 15, color: "#9C7B5A", margin: "6px 0 4px" }}>{total}問中 {score}問 正解</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: perfect?"#FF6B35":"#5C3D1E", marginBottom: 28 }}>{msg}</div>

      {perfect && (
        <div style={{ background: "linear-gradient(135deg,#FFF3DC,#FFE0A0)", border: "2.5px solid #FFCC44", borderRadius: 18, padding: "20px 24px", marginBottom: 28 }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: "#D97706" }}>🌟 全問正解！テスト本番もばっちり！</div>
        </div>
      )}

      {!perfect && wrongWords.length > 0 && (
        <div style={{ background: "white", border: "2px solid #EDD9B8", borderRadius: 18, padding: "18px 20px", marginBottom: 22, textAlign: "left" }}>
          <div style={{ fontWeight: 800, color: "#C0392B", marginBottom: 10, fontSize: 14 }}>❌ まちがえた語句（{wrongWords.length}個）</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {wrongWords.map((w, i) => (
              <span key={i} style={{ background: "#FFEBEE", border: "2px solid #FFCDD2", padding: "5px 14px", borderRadius: 99, fontSize: 16, fontFamily: "'Noto Serif JP',serif", color: "#C62828", fontWeight: 700 }}>
                {w.kanji}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {!perfect && wrongWords.length > 0 && (
          <button onClick={onRetryWrong}
            style={{ padding: "18px", borderRadius: 14, border: "none", background: "linear-gradient(135deg,#FF6B35,#FFAA00)", color: "white", fontSize: 17, fontWeight: 900, cursor: "pointer", fontFamily: "'Kaisei Opti','Noto Serif JP',serif", boxShadow: "0 4px 16px rgba(255,107,53,0.35)" }}>
            ⚡ まちがいだけやり直す！
          </button>
        )}
        <button onClick={onRetryAll}
          style={{ padding: "16px", borderRadius: 14, border: "2.5px solid #FF6B35", background: "white", color: "#FF6B35", fontSize: 15, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
          🔄 全問もう一度やる
        </button>
        <button onClick={onNewStudy}
          style={{ padding: "14px", borderRadius: 14, border: "2px solid #EDD9B8", background: "white", color: "#9C7B5A", fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
          📝 新しい範囲で勉強する
        </button>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("upload"); // upload | confirm | quiz | result
  const [words, setWords] = useState([]);
  const [queue, setQueue] = useState([]);
  const [qIdx, setQIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [wrongCounts, setWrongCounts] = useState({});
  const [wrongWords, setWrongWords] = useState([]);

  const startQuiz = (w, wc = {}) => {
    setWords(w); setQueue(buildQueue(w, wc)); setQIdx(0); setScore(0); setWrongWords([]);
    setScreen("quiz");
  };

  const handleAnswer = (correct) => {
    const cur = queue[qIdx];
    if (!correct) {
      setWrongCounts(prev => ({ ...prev, [cur.word.kanji]: (prev[cur.word.kanji]||0) + 1 }));
      setWrongWords(prev => prev.find(x => x.kanji===cur.word.kanji) ? prev : [...prev, cur.word]);
    } else {
      setScore(s => s + 1);
    }
    if (qIdx + 1 >= queue.length) setScreen("result");
    else setQIdx(i => i + 1);
  };

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#FFF8EE 0%,#FFE8C0 50%,#FFF0D8 100%)", padding: "20px 12px 56px", fontFamily: "'Hiragino Sans','Yu Gothic','Meiryo',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Kaisei+Opti:wght@400;700;800&family=Noto+Serif+JP:wght@400;700;900&display=swap');
        * { box-sizing: border-box; }
        button:active { transform: scale(0.97); }
        @keyframes fadeIn { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:translateY(0); } }
        @keyframes starPop { 0%{opacity:0;transform:scale(0) rotate(-30deg)} 60%{opacity:1;transform:scale(1.3) rotate(10deg)} 100%{opacity:0;transform:scale(1) translateY(-50px)} }
        .screen { animation: fadeIn 0.35s cubic-bezier(0.34,1.56,0.64,1) both; }
      `}</style>

      {screen === "upload" && (
        <div className="screen">
          <UploadScreen onWordsReady={w => { setWords(w); setScreen("confirm"); }} />
        </div>
      )}
      {screen === "confirm" && (
        <div className="screen">
          <ConfirmScreen words={words} onStart={w => { setWrongCounts({}); startQuiz(w); }} onBack={() => setScreen("upload")} />
        </div>
      )}
      {screen === "quiz" && queue[qIdx] && (
        <div className="screen" key={qIdx}>
          <QuestionCard entry={queue[qIdx]} idx={qIdx} total={queue.length} wrongCount={Object.keys(wrongCounts).length} onAnswer={handleAnswer} />
        </div>
      )}
      {screen === "result" && (
        <div className="screen">
          <ResultScreen score={score} total={queue.length} wrongWords={wrongWords}
            onRetryWrong={() => startQuiz(wrongWords.length>0?wrongWords:words, wrongCounts)}
            onRetryAll={() => startQuiz(words, wrongCounts)}
            onNewStudy={() => { setWrongCounts({}); setScreen("upload"); }}
          />
        </div>
      )}
    </div>
  );
}
