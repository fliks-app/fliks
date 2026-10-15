#!/usr/bin/env node
import 'reflect-metadata';
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, relative, dirname } from 'path';
import ts from 'typescript';
import { NestFactory } from '@nestjs/core';
import { MetadataScanner } from '@nestjs/core';
import { PathsExplorer } from '@nestjs/core/router/paths-explorer';
import { RoutePathFactory } from '@nestjs/core/router/route-path-factory';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PARAMTYPES_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
  SSE_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import type { NestContainer } from '@nestjs/core/injector/container';
import type { ApplicationConfig } from '@nestjs/core/application-config';
import { addLeadingSlash } from '@nestjs/common/utils/shared.utils';
import { AppModule } from '../src/app.module';

const BACKEND_ROOT = join(__dirname, '..');
const SRC_ROOT = join(BACKEND_ROOT, 'src');
const OUT_PATH = join(BACKEND_ROOT, '..', 'server', 'contract', 'nest-routes.json');

type RouteRecord = {
  method: string;
  path: string;
  controller: string;
  handler: string;
  file: string;
  line: number;
  guards: string[];
  policies: string;
  body?: string;
  query?: string;
  httpCode?: number;
  sse?: true;
  upload?: string;
};

type ClassLoc = { file: string; line: number };

const BUILTIN_CTORS = new Set<unknown>([
  String,
  Number,
  Boolean,
  Object,
  Array,
  Date,
  Buffer,
  Promise,
  Function,
]);

const controllerSourceCache = new Map<string, ts.SourceFile>();

function controllerSourceFile(fileRel: string): ts.SourceFile {
  let sf = controllerSourceCache.get(fileRel);
  if (!sf) {
    const abs = join(BACKEND_ROOT, fileRel);
    sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
    controllerSourceCache.set(fileRel, sf);
  }
  return sf;
}

function findHandlerMethod(
  sf: ts.SourceFile,
  handler: string,
): ts.MethodDeclaration | ts.GetAccessorDeclaration | undefined {
  let found: ts.MethodDeclaration | ts.GetAccessorDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === handler
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTsFiles(p));
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

function buildClassIndex(): Map<string, ClassLoc> {
  const index = new Map<string, ClassLoc>();
  const dupes = new Map<string, ClassLoc[]>();

  for (const file of walkTsFiles(SRC_ROOT)) {
    if (!file.endsWith('.controller.ts')) continue;
    const rel = relative(BACKEND_ROOT, file).replace(/\\/g, '/');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const loc = { file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 };
        const prev = index.get(name);
        if (prev) {
          const list = dupes.get(name) ?? [prev];
          list.push(loc);
          dupes.set(name, list);
        } else {
          index.set(name, loc);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  for (const [name, locs] of dupes) {
    throw new Error(
      `duplicate class ${name}: ${locs.map((l) => `${l.file}:${l.line}`).join(', ')}`,
    );
  }
  return index;
}

function handlerLine(fileRel: string, handler: string): number {
  const sf = controllerSourceFile(fileRel);
  const node = findHandlerMethod(sf, handler);
  if (!node) throw new Error(`handler ${handler} not found in ${fileRel}`);
  return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function checkPoliciesOf(node: ts.Node | undefined, sf: ts.SourceFile): string {
  for (const dec of (node && ts.getDecorators(node as ts.HasDecorators)) ?? []) {
    const expr = dec.expression;
    if (!ts.isCallExpression(expr)) continue;
    const callee = expr.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    if (name !== 'CheckPolicies') continue;
    return expr.arguments.map((arg) => arg.getText(sf)).join('\n');
  }
  return '';
}

// Handler wins over class, as in PoliciesGuard.
function policiesFromSource(fileRel: string, controller: string, handler: string): string {
  const sf = controllerSourceFile(fileRel);
  const own = checkPoliciesOf(findHandlerMethod(sf, handler), sf);
  if (own) return own;
  const cls = sf.statements.find(
    (st): st is ts.ClassDeclaration => ts.isClassDeclaration(st) && st.name?.text === controller,
  );
  return checkPoliciesOf(cls, sf);
}

function guardNames(guards: unknown[]): string[] {
  return guards.map((g) => {
    if (typeof g === 'function') return g.name;
    return (g as { constructor?: { name: string } })?.constructor?.name ?? 'UnknownGuard';
  });
}

function isDtoClass(metatype: unknown): metatype is new (...args: unknown[]) => unknown {
  if (typeof metatype !== 'function') return false;
  if (BUILTIN_CTORS.has(metatype)) return false;
  const name = metatype.name;
  if (!name) return false;
  return /^[A-Z]/.test(name);
}

function dtoFromRouteArgs(
  metatype: object,
  prototype: object,
  methodName: string,
  paramtype: RouteParamtypes,
): string | undefined {
  const routeArgs =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, methodName) ?? {};
  const paramtypes: unknown[] =
    Reflect.getMetadata(PARAMTYPES_METADATA, prototype, methodName) ?? [];
  for (const [key, meta] of Object.entries(routeArgs)) {
    if (Number(key.split(':')[0]) !== paramtype) continue;
    const index = (meta as { index: number }).index;
    const mt = paramtypes[index];
    if (isDtoClass(mt)) return mt.name;
  }
  return undefined;
}

function uploadInterceptorName(interceptors: unknown[]): string | undefined {
  for (const i of interceptors) {
    const cls = typeof i === 'function' ? i : (i as { constructor?: new () => unknown })?.constructor;
    if (!cls) continue;
    const src = cls.prototype?.intercept?.toString() ?? '';
    if (src.includes('.single(')) return 'FileInterceptor';
    if (src.includes('.array(')) return 'FilesInterceptor';
    if (src.includes('.fields(')) return 'FileFieldsInterceptor';
  }
  return undefined;
}

function controllerPaths(metatype: object): string[] {
  const path = Reflect.getMetadata(PATH_METADATA, metatype);
  if (path === undefined) return [''];
  if (Array.isArray(path)) return path.map((p) => addLeadingSlash(p));
  return [addLeadingSlash(path)];
}

function methodVerb(requestMethod: RequestMethod): string {
  return RequestMethod[requestMethod] ?? String(requestMethod);
}

async function collectRoutes(): Promise<RouteRecord[]> {
  const classIndex = buildClassIndex();
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  app.setGlobalPrefix('api', { exclude: ['engine/resolve'] });

  const appConfig = (app as unknown as { config: ApplicationConfig }).config;
  const routePathFactory = new RoutePathFactory(appConfig);
  const globalPrefix = appConfig.getGlobalPrefix();

  const pathsExplorer = new PathsExplorer(new MetadataScanner());
  // Preview mode creates no providers, so app.get() is unavailable: read the container.
  const { container } = app as unknown as { container: NestContainer };
  const controllers = [...container.getModules().values()].flatMap((m) => [...m.controllers.values()]);

  const records: RouteRecord[] = [];

  for (const wrapper of controllers) {
    const { metatype } = wrapper;
    if (!metatype) continue;

    const controllerName = metatype.name;
    const classLoc = classIndex.get(controllerName);
    if (!classLoc) throw new Error(`controller class ${controllerName} not found in src`);

    const prototype = metatype.prototype;
    const ctrlPaths = controllerPaths(metatype);
    const controllerGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, metatype) ?? [];
    const controllerInterceptors: unknown[] =
      Reflect.getMetadata(INTERCEPTORS_METADATA, metatype) ?? [];

    for (const route of pathsExplorer.scanForPaths(Object.create(prototype), prototype)) {
      const handler = route.methodName;
      const handlerFn = prototype[handler];
      const methodGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handlerFn) ?? [];
      const methodInterceptors: unknown[] =
        Reflect.getMetadata(INTERCEPTORS_METADATA, handlerFn) ?? [];
      const guards = guardNames([...controllerGuards, ...methodGuards]);
      const policies = policiesFromSource(classLoc.file, controllerName, handler);
      const httpCode = Reflect.getMetadata(HTTP_CODE_METADATA, handlerFn);
      const sseMeta = Reflect.getMetadata(SSE_METADATA, handlerFn);
      const body = dtoFromRouteArgs(metatype, prototype, handler, RouteParamtypes.BODY);
      const query = dtoFromRouteArgs(metatype, prototype, handler, RouteParamtypes.QUERY);
      const upload = uploadInterceptorName([...controllerInterceptors, ...methodInterceptors]);

      for (const ctrlPath of ctrlPaths) {
        for (const methodPath of route.path) {
          const paths = routePathFactory.create(
            {
              globalPrefix,
              ctrlPath,
              methodPath,
            },
            route.requestMethod,
          );
          for (const path of paths) {
            const rec: RouteRecord = {
              method: methodVerb(route.requestMethod),
              path,
              controller: controllerName,
              handler,
              file: classLoc.file,
              line: handlerLine(classLoc.file, handler),
              guards,
              policies,
            };
            if (body) rec.body = body;
            if (query) rec.query = query;
            if (httpCode !== undefined) rec.httpCode = httpCode;
            if (sseMeta) rec.sse = true;
            if (upload) rec.upload = upload;
            records.push(rec);
          }
        }
      }
    }
  }

  await app.close();
  records.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    if (a.method !== b.method) return a.method.localeCompare(b.method);
    return a.handler.localeCompare(b.handler);
  });
  return records;
}

async function main(): Promise<void> {
  const routes = await collectRoutes();
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(routes, null, 2)}\n`, 'utf8');
  console.log(`dump-routes: ${routes.length} routes → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
