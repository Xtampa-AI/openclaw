#!/bin/bash
# Script para actualizar el fork de OpenClaw de forma segura
# Protege archivos modificados y facilita resolución de conflictos

set -e

REPO_DIR="/root/kairos-agentes-ai/openclaw"
BACKUP_BASE="/root/kairos-evo/backups/openclaw"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${BACKUP_BASE}/update-${TIMESTAMP}"

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Archivos críticos a proteger (personalizaciones de Ner)
CRITICAL_PATTERNS=(
    ".agents/skills/.*kairos.*"
    "src/auth/.*"
    "src/slack/.*"
    ".env.*"
    "*.xcconfig"
    "config/.*"
)

echo -e "${BLUE}🔄 OpenClaw Fork Update Manager${NC}"
echo "================================================"

cd "$REPO_DIR"

# 1. Verificar estado del repositorio
echo -e "\n${YELLOW}📊 Verificando estado del repositorio...${NC}"
if [[ -n $(git status --porcelain) ]]; then
    echo -e "${RED}⚠️  Tienes cambios sin commit. Por favor, commitea o stashea primero.${NC}"
    git status --short
    exit 1
fi

# 2. Obtener información actual
echo -e "\n${YELLOW}📡 Obteniendo información de upstream...${NC}"
git fetch upstream
git fetch origin

CURRENT_BRANCH=$(git branch --show-current)
COMMITS_BEHIND=$(git rev-list --count HEAD..upstream/main)
COMMITS_AHEAD=$(git rev-list --count upstream/main..HEAD)

echo -e "Rama actual: ${GREEN}${CURRENT_BRANCH}${NC}"
echo -e "Commits detrás de upstream: ${YELLOW}${COMMITS_BEHIND}${NC}"
echo -e "Commits adelante de upstream: ${YELLOW}${COMMITS_AHEAD}${NC}"

if [ "$COMMITS_BEHIND" -eq 0 ]; then
    echo -e "\n${GREEN}✅ Tu fork ya está actualizado. No hay nada que hacer.${NC}"
    exit 0
fi

# 3. Crear backup completo
echo -e "\n${YELLOW}💾 Creando backup de seguridad...${NC}"
mkdir -p "$BACKUP_DIR"

# Backup del estado completo
git bundle create "$BACKUP_DIR/repo-bundle.git" --all
echo -e "${GREEN}✓${NC} Bundle creado en: $BACKUP_DIR/repo-bundle.git"

# Backup de archivos críticos
echo -e "\n${YELLOW}🛡️  Guardando archivos críticos...${NC}"
mkdir -p "$BACKUP_DIR/critical-files"

for pattern in "${CRITICAL_PATTERNS[@]}"; do
    find . -regex "$pattern" -type f 2>/dev/null | while read -r file; do
        rel_path="${file#./}"
        target="$BACKUP_DIR/critical-files/$rel_path"
        mkdir -p "$(dirname "$target")"
        cp "$file" "$target" 2>/dev/null || true
        echo -e "${GREEN}✓${NC} Protegido: $rel_path"
    done
done

# Guardar lista de archivos modificados
git diff --name-only fork/kairos-evo..HEAD > "$BACKUP_DIR/modified-files.txt"
echo -e "${GREEN}✓${NC} Lista de archivos modificados guardada"

# 4. Mostrar commits nuevos
echo -e "\n${YELLOW}📝 Commits nuevos en upstream:${NC}"
git log HEAD..upstream/main --oneline --max-count=10

# 5. Preguntar confirmación
echo -e "\n${YELLOW}❓ ¿Deseas continuar con el merge?${NC}"
echo "   - Se crearán backups automáticos"
echo "   - Puedes revertir con: git reset --hard ORIG_HEAD"
read -p "Continuar? [y/N]: " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}❌ Actualización cancelada${NC}"
    exit 1
fi

# 6. Realizar merge
echo -e "\n${YELLOW}🔀 Realizando merge con upstream/main...${NC}"
if git merge upstream/main --no-edit; then
    echo -e "${GREEN}✅ Merge completado exitosamente${NC}"
    
    # Verificar si hay conflictos
    if git diff --name-only --diff-filter=U | grep -q .; then
        echo -e "\n${YELLOW}⚠️  Conflictos detectados en:${NC}"
        git diff --name-only --diff-filter=U
        echo -e "\n${BLUE}💡 Usa 'git status' para ver los conflictos${NC}"
        echo -e "${BLUE}💡 Resuelve los conflictos y ejecuta 'git commit'${NC}"
    else
        echo -e "\n${GREEN}✨ No hay conflictos. Todo está listo.${NC}"
    fi
else
    echo -e "\n${RED}❌ Hubo problemas durante el merge${NC}"
    echo -e "${YELLOW}🔧 Opciones:${NC}"
    echo "   1. Resolver conflictos manualmente y ejecutar: git commit"
    echo "   2. Abortar el merge: git merge --abort"
    echo "   3. Restaurar desde backup: cd $BACKUP_DIR && git bundle unbundle repo-bundle.git"
    exit 1
fi

# 7. Resumen final
echo -e "\n${BLUE}================================================${NC}"
echo -e "${GREEN}✅ Actualización completada${NC}"
echo -e "\n${YELLOW}📦 Backup guardado en:${NC}"
echo "   $BACKUP_DIR"
echo -e "\n${YELLOW}🔄 Próximos pasos:${NC}"
echo "   1. Verificar que todo funciona: npm test"
echo "   2. Pushear a tu fork: git push fork $CURRENT_BRANCH"
echo "   3. Si algo falla, revertir: git reset --hard ORIG_HEAD"
echo -e "${BLUE}================================================${NC}"
