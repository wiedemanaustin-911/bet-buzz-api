import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import Sentiment from 'sentiment';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;
const sentiment = new Sentiment();

const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,' ').replace(/\s+/g,' ').trim();

/* ---------- CFBD schedule ---------- */
// GET /api/games?year=2025&week=1
app.get('/api/games', async (req,res)=>{
  try{
    const year = req.query.year || '2025';
    const week = req.query.week || '1';
    const r = await fetch(`https://api.collegefootballdata.com/games?year=${year}&seasonType=regular&week=${week}`,{
      headers:{ Authorization: `Bearer ${process.env.CFBD_API_KEY}` }
    });
    if(!r.ok) throw new Error('CFBD '+r.status);
    const data = await r.json();
    const games = data.map(g=>({
      id: String(g.id ?? `${norm(g.home_team)}-${norm(g.away_team)}-${g.start_date}`),
      kickoff: g.start_date, home: g.home_team, away: g.away_team,
      venue: g.venue || '', home_rank: g.home_ranking || null, away_rank: g.away_ranking || null
    }));
    res.json({games});
  }catch(e){ console.error(e); res.status(500).json({error:'CFBD schedule failed'}); }
});

/* ---------- Odds (TheOddsAPI) ---------- */
// GET /api/odds?home=Ohio%20State&away=Texas
app.get('/api/odds', async (req,res)=>{
  try{
    const {home,away} = req.query;
    if(!home || !away) return res.status(400).json({error:'home & away required'});

    const url = `https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm,pointsbetus&dateFormat=iso&apiKey=${process.env.ODDS_API_KEY}`;
    const r = await fetch(url);
    if(!r.ok) throw new Error('Odds '+r.status);
    const events = await r.json();

    const hN = norm(home), aN = norm(away);
    const ev = events.find(e=>{
      const eh = norm(e.home_team), ea = norm(e.away_team);
      return (eh===hN && ea===aN) || (eh===aN && ea===hN);
    });
    if(!ev) return res.status(404).json({error:'game not found in odds feed'});

    const spreadLines=[], moneyLines=[], totalLines=[];
    for(const bm of ev.bookmakers||[]){
      const book = (bm.key||bm.title||'book').toUpperCase();
      const mkts = bm.markets||[];

      const spread = mkts.find(m=>m.key==='spreads');
      if(spread?.outcomes?.length===2){
        const ho = spread.outcomes.find(o=>norm(o.name)===norm(ev.home_team));
        const ao = spread.outcomes.find(o=>norm(o.name)===norm(ev.away_team));
        if(ho && ao) spreadLines.push({book, home:ho.point, away:ao.point, price_home:ho.price, price_away:ao.price});
      }

      const h2h = mkts.find(m=>m.key==='h2h');
      if(h2h?.outcomes?.length===2){
        const ho = h2h.outcomes.find(o=>norm(o.name)===norm(ev.home_team));
        const ao = h2h.outcomes.find(o=>norm(o.name)===norm(ev.away_team));
        if(ho && ao) moneyLines.push({book, home:ho.price, away:ao.price});
      }

      const totals = mkts.find(m=>m.key==='totals');
      if(totals?.outcomes?.length===2){
        const over = totals.outcomes.find(o=>norm(o.name)==='over');
        const under = totals.outcomes.find(o=>norm(o.name)==='under');
        if(over && under) totalLines.push({book, over:over.point, under:under.point, price_over:over.price, price_under:under.price});
      }
    }
    const target = totalLines.length ? totalLines.reduce((a,b)=>a + (+b.over||+b.under||0),0)/totalLines.length : null;

    res.json({
      teams:{home:ev.home_team, away:ev.away_team},
      commence_time: ev.commence_time,
      spread:{side:'home', lines:spreadLines},
      moneyline:{side:'home', lines:moneyLines},
      total:{target, lines:totalLines}
    });
  }catch(e){ console.error(e); res.status(500).json({error:'odds fetch failed'}); }
});

/* ---------- Reddit chatter ---------- */
// GET /api/chatter?q=Texas%20Ohio%20State%20spread
let redditToken=null, redditExp=0;
async function getRedditToken(){
  const now = Date.now();
  if(redditToken && now < redditExp-60000) return redditToken;
  const creds = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://www.reddit.com/api/v1/access_token',{
    method:'POST',
    headers:{Authorization:`Basic ${creds}`,'Content-Type':'application/x-www-form-urlencoded'},
    body:'grant_type=client_credentials'
  });
  if(!r.ok) throw new Error('Reddit token '+r.status);
  const j = await r.json();
  redditToken = j.access_token; redditExp = Date.now() + j.expires_in*1000;
  return redditToken;
}
app.get('/api/chatter', async (req,res)=>{
  try{
    const q = req.query.q || 'college football betting';
    const token = await getRedditToken();
    const r = await fetch(`https://oauth.reddit.com/search?q=${encodeURIComponent(q)}&restrict_sr=0&sort=hot&limit=10`,{
      headers:{Authorization:`Bearer ${token}`,'User-Agent':'bet-buzz/0.1'}
    });
    if(!r.ok) throw new Error('Reddit search '+r.status);
    const j = await r.json();
    const items = (j.data?.children||[]).map(c=>c.data).filter(Boolean);
    const snippets = items.map(d=>{
      const text = (d.title + ' ' + (d.selftext||'')).slice(0,300);
      const s = sentiment.analyze(text);
      const score = Math.max(-1, Math.min(1, s.score/10));
      return {src:`Reddit r/${d.subreddit}`, text, url:`https://reddit.com${d.permalink}`, score};
    });
    const avg = snippets.length ? snippets.reduce((a,b)=>a+b.score,0)/snippets.length : 0;
    res.json({score:avg, snippets});
  }catch(e){ console.error(e); res.status(500).json({error:'reddit chatter failed'}); }
});
// === NEW: return ALL events with odds in one call ===
// GET /api/odds-all  -> { events: [ { id, commence_time, home, away, odds:{spread, moneyline, total} } ] }
app.get('/api/odds-all', async (req, res) => {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds` +
      `?regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm,pointsbetus` +
      `&dateFormat=iso&apiKey=${process.env.ODDS_API_KEY}`;

    const r = await fetch(url);
    if (!r.ok) throw new Error(`OddsAPI ${r.status}`);
    const events = await r.json();

    const out = events.map(ev => {
      const id = ev.id || `${(ev.away_team||'').toLowerCase()}-at-${(ev.home_team||'').toLowerCase()}-${ev.commence_time}`;
      const byKey = Object.fromEntries((ev.bookmakers||[]).map(bm => [bm.key || bm.title, bm]));

      // helper to pull and flatten a market across books
      const flatten = (marketKey) => {
        const lines = [];
        for (const bm of (ev.bookmakers || [])) {
          const book = (bm.key || bm.title || 'book').toUpperCase();
          const m = (bm.markets || []).find(x => x.key === marketKey);
          if (!m) continue;
          if (marketKey === 'spreads') {
            const h = m.outcomes?.find(o => o.name === ev.home_team);
            const a = m.outcomes?.find(o => o.name === ev.away_team);
            if (h && a) lines.push({ book, home: h.point, away: a.point, price_home: h.price, price_away: a.price });
          } else if (marketKey === 'h2h') {
            const h = m.outcomes?.find(o => o.name === ev.home_team);
            const a = m.outcomes?.find(o => o.name === ev.away_team);
            if (h && a) lines.push({ book, home: h.price, away: a.price });
          } else if (marketKey === 'totals') {
            const over = m.outcomes?.find(o => (o.name || '').toLowerCase() === 'over');
            const under = m.outcomes?.find(o => (o.name || '').toLowerCase() === 'under');
            if (over && under) lines.push({ book, over: over.point, under: under.point, price_over: over.price, price_under: under.price });
          }
        }
        return lines;
      };

      const totalLines = flatten('totals');
      const target = totalLines.length ? totalLines.reduce((a,b)=>a + (+b.over || +b.under || 0),0)/totalLines.length : null;

      return {
        id,
        commence_time: ev.commence_time,
        home: ev.home_team,
        away: ev.away_team,
        odds: {
          spread:   { side: 'home',   lines: flatten('spreads') },
          moneyline:{ side: 'home',   lines: flatten('h2h') },
          total:    { target,         lines: totalLines }
        }
      };
    });

    res.json({ events: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'odds-all failed' });
  }
});

app.listen(PORT, ()=>console.log(`API running on http://localhost:${PORT}`));
