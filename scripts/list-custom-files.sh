#!/bin/bash
# Script para identificar archivos personalizados de Ner en OpenClaw
# Útil para saber qué proteger en futuras actualizaciones

cd /root/kairos-agentes-ai/openclaw

echo "🔍 Archivos Personalizados de Kairos-EVO en OpenClaw"
echo "===================================================="
echo ""

echo "📁 Skills personalizados:"
find .agents/skills/ -type f -name "*kairos*" 2>/dev/null | sort
echo ""

echo "🔐 Configuraciones de autenticación:"
find . -path "*/auth/*" -type f \( -name "*.ts" -o -name "*.json" \) 2>/dev/null | grep -v node_modules | sort
echo ""

echo "💬 Integraciones de Slack:"
find . -path "*/slack/*" -type f -name "*.ts" 2>/dev/null | grep -v node_modules | sort
echo ""

echo "🔧 Archivos de configuración:"
find . -maxdepth 2 -type f \( -name ".env*" -o -name "*.xcconfig" \) 2>/dev/null | grep -v ".example" | sort
echo ""

echo "📝 Commits únicos de este fork (últimos 20):"
git log fork/kairos-evo..HEAD --pretty=format:"%h %s" --max-count=20
echo ""
echo ""

echo "📊 Resumen de modificaciones:"
echo "   Total archivos modificados: $(git diff fork/kairos-evo..HEAD --name-only | wc -l)"
echo "   Archivos añadidos: $(git diff fork/kairos-evo..HEAD --name-status | grep '^A' | wc -l)"
echo "   Archivos modificados: $(git diff fork/kairos-evo..HEAD --name-status | grep '^M' | wc -l)"
echo "   Archivos eliminados: $(git diff fork/kairos-evo..HEAD --name-status | grep '^D' | wc -l)"
echo ""

echo "💾 Para crear backup manual de estos archivos:"
echo "   tar -czf ~/openclaw-custom-$(date +%Y%m%d).tar.gz \\"
echo "     .agents/skills/*kairos* \\"
echo "     src/auth/ \\"
echo "     src/slack/ \\"
echo "     .env.* \\"
echo "     *.xcconfig"
