import { parse, type AnyNode } from 'acorn';
import type { Parameter, SourceModule } from '../src/types.js';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('上游返回的数据结构无效');
  return value as Record<string, unknown>;
}
export interface WidgetModule extends SourceModule { functionName: string; }
export interface WidgetMetadata { title: string; description?: string; version?: string; icon?: string; modules: WidgetModule[]; search?: WidgetModule; }

/** Read the metadata language, never evaluate downloaded JavaScript in the server. */
export function parseWidgetMetadata(code: string): WidgetMetadata {
  const program = parse(code, { ecmaVersion: 'latest' });
  const declarations = new Map<string, AnyNode>();
  for (const statement of program.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) if (declaration.id.type === 'Identifier' && declaration.init) declarations.set(declaration.id.name, declaration.init);
  }
  const visiting = new Set<string>();
  const literal = (node: AnyNode | null, depth = 0): unknown => {
    if (!node || depth > 35) throw new Error('组件元数据嵌套过深');
    const child = (value: AnyNode | null) => literal(value, depth + 1);
    switch (node.type) {
      case 'Literal': return node.value;
      case 'Identifier': {
        if (visiting.has(node.name) || !declarations.has(node.name)) throw new Error(`元数据引用无效: ${node.name}`);
        visiting.add(node.name);
        try { return child(declarations.get(node.name)!); } finally { visiting.delete(node.name); }
      }
      case 'ArrayExpression': return node.elements.map(child);
      case 'ObjectExpression': {
        const value: Record<string, unknown> = Object.create(null);
        for (const property of node.properties) {
          if (property.type === 'SpreadElement') { Object.assign(value, child(property.argument)); continue; }
          if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.computed) throw new Error('不支持的元数据属性');
          const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? String(property.key.value) : '';
          if (['__proto__','constructor','prototype'].includes(key)) throw new Error('不允许的元数据属性');
          value[key] = child(property.value);
        }
        return value;
      }
      case 'BinaryExpression': if (node.operator === '+') { const left = child(node.left); const right = child(node.right); return typeof left === 'number' && typeof right === 'number' ? left + right : String(left) + String(right); } break;
      case 'UnaryExpression': if (node.operator === '-') return -Number(child(node.argument)); break;
      case 'CallExpression':
        if (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Object' && node.callee.property.type === 'Identifier' && node.callee.property.name === 'assign') return Object.assign(Object.create(null), ...node.arguments.map(child));
        break;
    }
    throw new Error(`组件元数据包含不可静态解析表达式: ${node.type}`);
  };
  const root = declarations.get('WidgetMetadata');
  if (!root) throw new Error('组件缺少 WidgetMetadata');
  const metadata = record(literal(root));
  const parameters = (values: unknown): Parameter[] => {
    if (values === undefined) return [];
    if (!Array.isArray(values)) throw new Error('组件参数结构无效');
    return values.map(entry => {
      const value = record(entry);
      if (typeof value.name !== 'string') throw new Error('组件参数缺少名称');
      return {
        name: value.name, title: String(value.title || value.name), type: String(value.type || 'input'),
        ...(value.value !== undefined ? { value: String(value.value) } : {}),
        ...(value.defaultValue !== undefined ? { defaultValue: String(value.defaultValue) } : {}),
        ...(Array.isArray(value.enumOptions) ? { enumOptions: value.enumOptions.map(entry => { const option = record(entry); return { title: String(option.title), value: String(option.value) }; }) } : {}),
      };
    });
  };
  const module = (entry: unknown, index: number): WidgetModule => {
    const value = record(entry);
    if (typeof value.functionName !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(value.functionName)) throw new Error('组件模块函数无效');
    return { id: String(value.id || `${value.functionName}-${index}`), title: String(value.title || value.functionName), functionName: value.functionName, params: parameters(value.params) };
  };
  if (!Array.isArray(metadata.modules) || !metadata.modules.length) throw new Error('组件未提供浏览模块');
  return { title: String(metadata.title), description: String(metadata.description || ''), version: String(metadata.version || ''), icon: String(metadata.icon || ''), modules: metadata.modules.map(module), ...(metadata.search ? { search: module(metadata.search, -1) } : {}) };
}
