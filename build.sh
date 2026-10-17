#!/bin/sh
# Arma index.html para growth.strikd.ai a partir del tablero (src/board.html).
set -e
V="$(date -u +%Y-%m-%d\ %H:%M:%S) UTC"; Q="$(date -u +%s)"
{
  printf '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
  printf '<script>window.STRIKD_BUILD="%s"</script>\n' "$V"
  printf '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="STRIKD"><meta name="apple-mobile-web-app-status-bar-style" content="black"><meta name="theme-color" content="#000000">\n'
  printf '<link rel="stylesheet" href="/auth.css?v='"$Q"'">\n'
  printf '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>\n'
  printf '<script src="/claude-shim.js?v='"$Q"'"></script>\n</head><body>\n'
  cat src/board.html
  printf '\n</body></html>\n'
} > index.html
printf '%s\n' "$V" > version.txt
echo "index.html listo"
