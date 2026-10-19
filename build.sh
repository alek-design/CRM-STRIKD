#!/bin/sh
# Arma index.html para growth.strikd.ai a partir del tablero (src/board.html).
set -e
V="$(date -u +%Y-%m-%d\ %H:%M:%S) UTC"; Q="$(date -u +%s)"
{
  printf '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
  printf '<script>window.STRIKD_BUILD="%s"</script>\n' "$V"
  # si algo truena en el teléfono, se ve en pantalla (abajo) para poder mandar captura
  printf '%s\n' '<script>(function(){var n=0;function show(t){try{var bm=document.getElementById("bootMsg");if(!document.getElementById("sgAuth")&&bm&&bm.hidden)return;if(++n>3)return;var b=document.getElementById("errBox");if(!b){b=document.createElement("div");b.id="errBox";b.style.cssText="position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;background:#7f1d1d;color:#fff;font:12px/1.35 -apple-system,system-ui,sans-serif;padding:8px 10px;border-radius:10px;pointer-events:none;white-space:pre-wrap;word-break:break-word";(document.body||document.documentElement).appendChild(b);}b.textContent+=(b.textContent?"\n":"")+"Error: "+String(t).slice(0,220);}catch(_){}}window.addEventListener("error",function(e){show((e.message||"")+(e.filename?" @"+e.filename.split("/").pop()+":"+e.lineno:""));});window.addEventListener("unhandledrejection",function(e){var r=e.reason;show("promesa: "+(r&&(r.message||r.code)||r));});})();</script>'
  printf '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="STRIKD"><meta name="apple-mobile-web-app-status-bar-style" content="black"><meta name="theme-color" content="#000000">\n'
  printf '<link rel="stylesheet" href="/auth.css?v='"$Q"'">\n'
  printf '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>\n'
  printf '<script src="/claude-shim.js?v='"$Q"'"></script>\n</head><body>\n'
  cat src/board.html
  printf '\n</body></html>\n'
} > index.html
printf '%s\n' "$V" > version.txt
echo "index.html listo"
