'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 从 settings.yaml 解析模型目录（llm-pi-ai.providers 自定义路由）。
 * 定向缩进解析：只提取 provider/模型/effort 档位与 agent-default-model，
 * 不引入 YAML 依赖；文件由 dsh Models 页与用户共同维护，结构稳定。
 *
 * @param {string} yamlText - settings.yaml 全文。
 * @returns {{providers: Array, defaultModel: object|null}} 模型目录。
 */
function parseModelCatalog(yamlText) {
  const lines = String(yamlText).split(/\r?\n/);
  const catalog = { providers: [], defaultModel: null };

  // agent-default-model（顶层块）：provider / model / reasoningEffort。
  const di = lines.findIndex((line) => line.trim() === 'agent-default-model:');
  if (di !== -1) {
    const block = {};
    for (let i = di + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(\s+)([A-Za-z]+):\s*(.*)$/);
      if (!m) break;
      block[m[2]] = m[3];
    }
    if (block.provider && block.model) {
      catalog.defaultModel = {
        provider: block.provider,
        model: block.model,
        reasoningEffort: block.reasoningEffort || undefined,
      };
    }
  }

  // llm-pi-ai: → providers: → <provider>: → models: → - id: / name: / reasoningEfforts:
  let inSection = false;
  let inProviders = false;
  let current = null;
  let currentModel = null;
  let inEfforts = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    if (indent === 0) {
      inSection = trimmed === 'llm-pi-ai:';
      inProviders = false;
      current = null;
      currentModel = null;
      inEfforts = false;
      continue;
    }
    if (!inSection) continue;

    if (indent === 2) {
      inProviders = trimmed === 'providers:';
      current = null;
      currentModel = null;
      inEfforts = false;
      continue;
    }
    if (!inProviders) continue;

    if (indent === 4) {
      const m = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
      current = m ? { id: m[1], displayName: m[1], models: [] } : null;
      if (current) catalog.providers.push(current);
      currentModel = null;
      inEfforts = false;
      continue;
    }
    if (!current) continue;

    if (indent === 6) {
      if (trimmed.startsWith('displayName:')) current.displayName = trimmed.slice('displayName:'.length).trim() || current.id;
      currentModel = null;
      inEfforts = false;
      continue;
    }

    if (indent === 8) {
      const m = trimmed.match(/^-\s*id:\s*(\S+)\s*$/);
      if (m) {
        currentModel = { id: m[1], name: m[1] };
        current.models.push(currentModel);
        inEfforts = false;
      } else {
        currentModel = null;
        inEfforts = false;
      }
      continue;
    }

    if (!currentModel) continue;
    if (inEfforts) {
      if (indent >= 12) {
        const m = trimmed.match(/^"?([A-Za-z0-9]+)"?:/);
        if (m) currentModel.efforts.push(m[1]);
        continue;
      }
      inEfforts = false;
    }
    const nm = trimmed.match(/^name:\s*(.*)$/);
    if (nm) {
      currentModel.name = nm[1].trim() || currentModel.name;
      continue;
    }
    if (trimmed === 'reasoningEfforts:') {
      currentModel.efforts = [];
      inEfforts = true;
    }
  }
  return catalog;
}

/** 从 config.dshHome/settings.yaml 读取模型目录；文件缺失返回 null。 */
function loadModelCatalog(config) {
  if (!config || !config.dshHome) return null;
  const settingsPath = path.join(config.dshHome, 'settings.yaml');
  try {
    if (!fs.existsSync(settingsPath)) return null;
    return parseModelCatalog(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * 把 /model 的目标参数解析成 provider + model (+ reasoningEffort)。
 * 目标可以是模型 id（跨 provider 唯一时）或 `provider/model` 全名；
 * 歧义时优先默认 provider；effort 会按该模型的档位白名单校验。
 */
function resolveModelTarget(catalog, target, effort) {
  const matches = [];
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      const fullName = `${provider.id}/${model.id}`;
      if (model.id === target || model.id.endsWith(`/${target}`) || fullName === target) {
        matches.push({ provider: provider.id, model: model.id, efforts: model.efforts });
      }
    }
  }
  if (!matches.length) return { error: `未找到模型 \`${target}\`，发送 /model 查看可用列表` };
  let pick = matches[0];
  if (matches.length > 1) {
    const preferred = catalog.defaultModel && matches.find((m) => m.provider === catalog.defaultModel.provider);
    if (!preferred) return { error: `模型 \`${target}\` 存在于多个 provider（${matches.map((m) => m.provider).join('、')}），请用 \`provider/模型名\` 全名` };
    pick = preferred;
  }
  const resolved = { provider: pick.provider, model: pick.model };
  if (effort !== undefined) {
    if (pick.efforts && !pick.efforts.includes(effort)) {
      return { error: `模型 \`${pick.model}\` 支持的 effort: ${pick.efforts.join(' / ')}` };
    }
    resolved.reasoningEffort = effort;
  }
  return resolved;
}

module.exports = { parseModelCatalog, loadModelCatalog, resolveModelTarget };
