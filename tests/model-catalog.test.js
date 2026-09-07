'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseModelCatalog, loadModelCatalog, resolveModelTarget } = require('../src/core/model-catalog');

const FIXTURE = [
  'ui-onboarding:',
  '  welcomeNoticeVersion: 2026-08-13.1',
  'agent-default-model:',
  '  provider: volcengine-agent-plan',
  '  model: deepseek-v4-flash',
  '  reasoningEffort: high',
  'llm-pi-ai:',
  '  providers:',
  '    volcengine-agent-plan:',
  '      displayName: Volcengine Ark Agent Plan (Small)',
  '      apiKeyEnv: volce',
  '      api: openai-responses',
  '      baseURL: https://ark.cn-beijing.volces.com/api/plan/v3',
  '      reasoning: high',
  '      models:',
  '        - id: ark-code-latest',
  '          name: Ark Code Latest',
  '        - id: deepseek-v4-flash',
  '          name: DeepSeek V4 Flash',
  '          reasoningEfforts:',
  '            "off":',
  '            low: low',
  '            high: high',
  '            max: max',
  '    zhipu-coding-plan:',
  '      displayName: Zhipu GLM Coding Plan',
  '      models:',
  '        - id: glm-5.3',
  '          name: GLM-5.3',
  '        - id: deepseek-v4-pro',
  '          name: DeepSeek V4 Pro',
  '          reasoningEfforts:',
  '            high: high',
  '            max: max',
].join('\n');

test('parseModelCatalog 提取 provider、模型、effort 档位与默认模型', () => {
  const catalog = parseModelCatalog(FIXTURE);

  assert.strictEqual(catalog.providers.length, 2);
  const [volc, zhipu] = catalog.providers;
  assert.strictEqual(volc.id, 'volcengine-agent-plan');
  assert.strictEqual(volc.displayName, 'Volcengine Ark Agent Plan (Small)');
  assert.strictEqual(volc.models.length, 2);
  assert.deepStrictEqual(volc.models[0], { id: 'ark-code-latest', name: 'Ark Code Latest' });
  assert.strictEqual(volc.models[1].id, 'deepseek-v4-flash');
  assert.deepStrictEqual(volc.models[1].efforts, ['off', 'low', 'high', 'max']);

  assert.strictEqual(zhipu.models[0].id, 'glm-5.3');
  assert.strictEqual(zhipu.models[0].efforts, undefined);
  assert.deepStrictEqual(zhipu.models[1].efforts, ['high', 'max']);

  assert.deepStrictEqual(catalog.defaultModel, {
    provider: 'volcengine-agent-plan',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  });
});

test('resolveModelTarget 解析唯一模型并校验 effort 白名单', () => {
  const catalog = parseModelCatalog(FIXTURE);

  assert.deepStrictEqual(resolveModelTarget(catalog, 'ark-code-latest'), {
    provider: 'volcengine-agent-plan',
    model: 'ark-code-latest',
  });
  assert.deepStrictEqual(resolveModelTarget(catalog, 'glm-5.3', 'max'), {
    provider: 'zhipu-coding-plan',
    model: 'glm-5.3',
    reasoningEffort: 'max',
  });
  // 无 effort 档位定义的模型不做白名单校验，直接透传。
  assert.deepStrictEqual(resolveModelTarget(catalog, 'glm-5.3', 'off').reasoningEffort, 'off');
  assert.match(resolveModelTarget(catalog, 'deepseek-v4-pro', 'off').error, /effort: high \/ max/);
  assert.match(resolveModelTarget(catalog, 'no-such-model').error, /未找到模型/);
});

test('resolveModelTarget 跨 provider 重名时优先默认 provider，否则要求全名', () => {
  const catalog = parseModelCatalog(FIXTURE);
  // 构造重名场景：zhipu 也提供 deepseek-v4-flash。
  const clone = parseModelCatalog(FIXTURE);
  clone.providers[1].models.push({ id: 'deepseek-v4-flash', name: 'dup' });

  // 默认 provider 是 volcengine → 优先命中它。
  assert.deepStrictEqual(resolveModelTarget(clone, 'deepseek-v4-flash').provider, 'volcengine-agent-plan');

  // 无默认 provider 时要求全名（复用上面的重名场景）。
  const noDefault = clone;
  noDefault.defaultModel = null;
  assert.match(resolveModelTarget(noDefault, 'deepseek-v4-flash').error, /多个 provider/);
  assert.deepStrictEqual(resolveModelTarget(noDefault, 'zhipu-coding-plan/deepseek-v4-pro'), {
    provider: 'zhipu-coding-plan',
    model: 'deepseek-v4-pro',
  });
});

test('loadModelCatalog 文件缺失返回 null', () => {
  assert.strictEqual(loadModelCatalog({ dshHome: '/nonexistent-home-for-test' }), null);
});
