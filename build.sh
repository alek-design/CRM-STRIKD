#!/bin/sh
# Arma index.html para growth.strikd.ai a partir del tablero (src/board.html).
set -e
{
  printf '<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
  printf '<link rel="stylesheet" href="/auth.css">\n'
  printf '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>\n'
  printf '<script src="/claude-shim.js"></script>\n</head><body>\n'
  cat src/board.html
  printf '\n</body></html>\n'
} > index.html
echo "index.html listo"
