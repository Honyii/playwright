/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// @ts-check

const path = require('path');
const Documentation = require('./documentation');
const XmlDoc = require('./xmlDocumentation')
const PROJECT_DIR = path.join(__dirname, '..', '..');
const fs = require('fs');
const { parseApi } = require('./api_parser');
const { Type } = require('./documentation');
const { EOL } = require('os');
const { execSync } = require('child_process');

const maxDocumentationColumnWidth = 80;
Error.stackTraceLimit = 100;

/** @type {Map<string, Documentation.Type>} */
const modelTypes = new Map(); // this will hold types that we discover, because of .NET specifics, like results
/** @type {Map<string, string>} */
const documentedResults = new Map(); // will hold documentation for new types
/** @type {Map<string, string[]>} */
const enumTypes = new Map();
const nullableTypes = ['int', 'bool', 'decimal', 'float'];
const customTypeNames = new Map([
  ['domcontentloaded', 'DOMContentLoaded'],
  ['networkidle', 'NetworkIdle'],
  ['File', 'FilePayload'],
]);

const typesDir = process.argv[2] || path.join(__dirname, 'generate_types', 'csharp');
const modelsDir = path.join(typesDir, "models");
const enumsDir = path.join(typesDir, "enums");

for (const dir of [typesDir, modelsDir, enumsDir])
  fs.mkdirSync(dir, { recursive: true });

const documentation = parseApi(path.join(PROJECT_DIR, 'docs', 'src', 'api'));
documentation.filterForLanguage('csharp');

documentation.setLinkRenderer(item => {
  if (item.clazz)
    return `<see cref="I${toTitleCase(item.clazz.name)}"/>`;
  else if (item.member)
    return `<see cref="I${toTitleCase(item.member.clazz.name)}.${toMemberName(item.member)}"/>`;
  else if (item.option)
    return `<paramref name="${item.option}"/>`;
  else if (item.param)
    return `<paramref name="${item.param}"/>`;
  else
    throw new Error('Unknown link format.');
});

// get the template for a class
const template = fs.readFileSync(path.join(__dirname, 'templates', 'interface.cs'), 'utf-8')
  .replace('[PW_TOOL_VERSION]', `${__filename.substring(path.join(__dirname, '..', '..').length).split(path.sep).join(path.posix.sep)}`);

// we have some "predefined" types, like the mixed state enum, that we can map in advance
enumTypes.set("MixedState", ["On", "Off", "Mixed"]);

// map the name to a C# friendly one (we prepend an I to denote an interface)
const classNameMap = new Map(documentation.classesArray.map(x => [x.name, `I${toTitleCase(x.name)}`]));

// map some types that we know of
classNameMap.set('Error', 'Exception');
classNameMap.set('TimeoutError', 'TimeoutException');
classNameMap.set('EvaluationArgument', 'object');
classNameMap.set('boolean', 'bool');
classNameMap.set('Serializable', 'T');
classNameMap.set('any', 'object');
classNameMap.set('Buffer', 'byte[]');
classNameMap.set('path', 'string');
classNameMap.set('URL', 'string');
classNameMap.set('RegExp', 'Regex');
classNameMap.set('Readable', 'Stream');

/**
 *
 * @param {string} kind
 * @param {string} name
 * @param {Documentation.MarkdownNode[]} spec
 * @param {string[]} body
 * @param {string} folder
 * @param {string} extendsName
 */
function writeFile(kind, name, spec, body, folder, extendsName = null) {
  const out = [];
  console.log(`Generating ${name}`);

  if (spec)
    out.push(...XmlDoc.renderXmlDoc(spec, maxDocumentationColumnWidth));
  else {
    let ownDocumentation = documentedResults.get(name);
    if (ownDocumentation) {
      out.push('/// <summary>');
      out.push(`/// ${ownDocumentation}`);
      out.push('/// </summary>');
    }
  }

  if (extendsName === 'IEventEmitter')
    extendsName = null;

  out.push(`public ${kind} ${name}${extendsName ? ` : ${extendsName}` : ''}`);
  out.push('{');
  out.push(...body);
  out.push('}');

  let content = template.replace('[CONTENT]', out.join(EOL));
  fs.writeFileSync(path.join(folder, name + '.generated.cs'), content);
}

function renderClass(clazz) {
  const name = classNameMap.get(clazz.name);
  if (name === 'TimeoutException')
    return;

  const body = [];
  for (const member of clazz.membersArray)
    renderMember(member, clazz, body);

  writeFile(
      'partial interface',
      name,
      clazz.spec,
      body,
      typesDir,
      clazz.extends ? `I${toTitleCase(clazz.extends)}` : null);
}

/**
 * @param {string} name
 * @param {Documentation.Type} type
 */
function renderModelType(name, type) {
  const body = [];
  // TODO: consider how this could be merged with the `translateType` check
  if (type.union
    && type.union[0].name === 'null'
    && type.union.length == 2) {
    type = type.union[1];
  }

  if (type.name === 'Array') {
    throw new Error('Array at this stage is unexpected.');
  } else if (type.properties) {
    for (const member of type.properties) {
      let fakeType = new Type(name, null);
      renderMember(member, fakeType, body);
    }
  } else {
    console.log(type);
    throw new Error(`Not sure what to do in this case.`);
  }
  writeFile('partial class', name, null, body, modelsDir);
}

/**
 * @param {string} name
 * @param {string[]} literals
 */
function renderEnum(name, literals) {
  const body = [];
  body.push('Undefined = 0,');
  for (let literal of literals) {
    // strip out the quotes
    literal = literal.replace(/[\"]/g, ``)
    let escapedName = literal.replace(/[-]/g, ' ')
      .split(' ')
      .map(word => customTypeNames.get(word) || word[0].toUpperCase() + word.substring(1)).join('');

    body.push(`[EnumMember(Value = "${literal}")]`);
    body.push(`${escapedName},`);
  }
  writeFile('enum', name, null, body, enumsDir);
}

for (const element of documentation.classesArray)
  renderClass(element);

for (let [name, type] of modelTypes)
  renderModelType(name, type);

for (let [name, literals] of enumTypes)
  renderEnum(name, literals);

if (process.argv[3] !== "--skip-format") {
  // run the formatting tool for .net, to ensure the files are prepped
  execSync(`dotnet format -f "${typesDir}" --include-generated --fix-whitespace`);
  if (process.platform !== 'win32') {
    for (const folder of [typesDir, path.join(typesDir, 'Models'), path.join(typesDir, 'Enums'), path.join(typesDir, 'Extensions'), path.join(typesDir, 'Constants')])
    for (const name of fs.readdirSync(folder)) {
      if (!name.includes('\.cs'))
        continue;
      const content = fs.readFileSync(path.join(folder, name), 'utf-8');
      fs.writeFileSync(path.join(folder, name), content.split('\r\n').join('\n'));
    }
  }
}

/**
 * @param {string} name
 */
function toArgumentName(name) {
  return name === 'event' ? `@${name}` : name;
}

 /**
 * @param {Documentation.Member} member
 * @param {{ omitAsync?: boolean; }=} options
 */
function toMemberName(member, options) {
  const assumedName = toTitleCase(member.alias || member.name);
  if (member.kind === 'interface')
    return `I${assumedName}`;
  const omitAsync = options && options.omitAsync;
  if (!omitAsync && member.kind === 'method' && member.async && !assumedName.endsWith('Async'))
    return `${assumedName}Async`;
  return assumedName;
}

/**
 * @param {string} name
 * @returns {string}
 */
function toTitleCase(name) {
  if (name === 'dblclick')
    return 'DblClick';
  name = name.replace(/(HTTP[S]?)/g, (m, g) => {
    return g[0].toUpperCase() + g.substring(1).toLowerCase();
  });
  return name.charAt(0).toUpperCase() + name.substring(1);
}

/**
 *
 * @param {Documentation.Member} member
 * @param {Documentation.Class|Documentation.Type} parent
 * @param {string[]} out
 */
function renderMember(member, parent, out) {
  let name = toMemberName(member);
  if (member.kind === 'method') {
    renderMethod(member, parent, name, out);
  } else {
    /** @type string */
    let type = translateType(member.type, parent, t => generateNameDefault(member, name, t, parent));
    if (member.kind === 'event') {
      if (!member.type)
        throw new Error(`No Event Type for ${name} in ${parent.name}`);
      if (member.spec)
        out.push(...XmlDoc.renderXmlDoc(member.spec, maxDocumentationColumnWidth));
      out.push(`event EventHandler<${type}> ${name};`);
    } else if (member.kind === 'property') {
      if (member.spec)
        out.push(...XmlDoc.renderXmlDoc(member.spec, maxDocumentationColumnWidth));
      let propertyOrigin = member.name;
      if (member.type.expression === '[string]|[float]')
        propertyOrigin = `${member.name}String`;
      if (!member.clazz)
        out.push(`[JsonPropertyName("${propertyOrigin}")]`)
      if (parent && member && member.name === 'children') {  // this is a special hack for Accessibility
        console.warn(`children property found in ${parent.name}, assuming array.`);
        type = `IEnumerable<${parent.name}>`;
      }

      if (!type.endsWith('?') && !member.required && nullableTypes.includes(type))
        type = `${type}?`;
      if (member.clazz)
        out.push(`public ${type} ${name} { get; }`);
      else
        out.push(`public ${type} ${name} { get; set; }`);
    } else {
      throw new Error(`Problem rendering a member: ${type} - ${name} (${member.kind})`);
    }
  }
  out.push('');
}

/**
 *
 * @param {Documentation.Member} member
 * @param {string} name
 * @param {Documentation.Type} t
 * @param {*} parent
 */
function generateNameDefault(member, name, t, parent) {
  if (!t.properties
    && !t.templates
    && !t.union
    && t.expression === '[Object]')
    return 'object';

  // we'd get this call for enums, primarily
  let enumName = generateEnumNameIfApplicable(t);
  if (!enumName && member) {
    if (member.kind === 'method' || member.kind === 'property') {
      let names = [
        parent.alias || parent.name,
        toTitleCase(member.alias || member.name),
        toTitleCase(name),
      ];
      if (names[2] === names[1])
        names.pop(); // get rid of duplicates, cheaply
      let attemptedName = names.pop();
      let typesDiffer = function (left, right) {
        if (left.expression && right.expression)
          return left.expression !== right.expression;
        return JSON.stringify(right.properties) !== JSON.stringify(left.properties);
      }
      while (true) {
        // crude attempt at removing plurality
        if (attemptedName.endsWith('s')
          && !["properties", "httpcredentials"].includes(attemptedName.toLowerCase()))
          attemptedName = attemptedName.substring(0, attemptedName.length - 1);
        if (customTypeNames.get(attemptedName))
          attemptedName = customTypeNames.get(attemptedName);
        let probableType = modelTypes.get(attemptedName);
        if ((probableType && typesDiffer(t, probableType))
          || (["Value"].includes(attemptedName))) {
          if (!names.length)
            throw new Error(`Ran out of possible names: ${attemptedName}`);
          attemptedName = `${names.pop()}${attemptedName}`;
          continue;
        } else {
          modelTypes.set(attemptedName, t);
        }
        break;
      }
      return attemptedName;
    }

    if (member.kind === 'event') {
      return `${name}Payload`;
    }
  }

  return enumName || t.name;
}

/**
 * 
 * @param {Documentation.Type} type 
 * @returns 
 */
function generateEnumNameIfApplicable(type) {
  if (!type.union)
    return null;

  const potentialValues = type.union.filter(u => u.name.startsWith('"'));
  if ((potentialValues.length !== type.union.length)
    && !(type.union[0].name === 'null' && potentialValues.length === type.union.length - 1)) {
    return null; // this isn't an enum, so we don't care, we let the caller generate the name
  }
  return type.name;
}

/**
 * Rendering a method is so _special_, with so many weird edge cases, that it
 * makes sense to put it separate from the other logic.
 * @param {Documentation.Member} member
 * @param {Documentation.Class | Documentation.Type} parent
 * @param {string} name
 * @param {string[]} out
 */
function renderMethod(member, parent, name, out) {
 
  /**
   * @param {Documentation.Type} type 
   * @returns 
   */
  function resolveType(type) {
    return translateType(type, parent, (t) => {
      let newName = `${parent.name}${toMemberName(member, { omitAsync: true })}Result`;
      documentedResults.set(newName, `Result of calling <see cref="I${toTitleCase(parent.name)}.${toMemberName(member)}"/>.`);
      return newName;
    });
  }

  /** @type {Map<string, string[]>} */
  const paramDocs = new Map();
  const addParamsDoc = (paramName, docs) => {
    if (paramName.startsWith('@'))
      paramName = paramName.substring(1);
    if (paramDocs.get(paramName))
      throw new Error(`Parameter ${paramName} already exists in the docs.`);
    paramDocs.set(paramName, docs);
  };

  /** @type {string} */
  let type = null;
  // need to check the original one
  if (member.type.name === 'Object' || member.type.name === 'Array') {
    let innerType = member.type;
    let isArray = false;
    if (innerType.name === 'Array') {
      // we want to influence the name, but also change the object type
      innerType = member.type.templates[0];
      isArray = true;
    }

    if (innerType.expression === '[Object]<[string], [string]>') {
      // do nothing, because this is handled down the road
    } else if (!isArray && !innerType.properties) {
      type = `dynamic`;
    } else {
      type = classNameMap.get(innerType.name);
      if (!type)
        type = resolveType(innerType);
      if (isArray)
        type = `IReadOnlyCollection<${type}>`;
    }
  }

  type = type || resolveType(member.type);
  // TODO: this is something that will probably go into the docs
  // translate simple getters into read-only properties, and simple
  // set-only methods to settable properties
  if (member.args.size == 0
    && type !== 'void'
    && !name.startsWith('Get')
    && !name.startsWith('As')) {
    if (!member.async) {
      if (member.spec)
        out.push(...XmlDoc.renderXmlDoc(member.spec, maxDocumentationColumnWidth));
      out.push(`${type} ${name} { get; }`);
      return;
    }
  }

  // HACK: special case for generics handling!
  if (type === 'T') {
    name = `${name}<T>`;
  }

  // adjust the return type for async methods
  if (member.async) {
    if (type === 'void')
      type = `Task`;
    else
      type = `Task<${type}>`;
  }

  // render args
  /** @type {string[]} */
  let args = [];
  /** @type {string[]} */
  let explodedArgs = [];
  /** @type {Map<string, string>} */
  let argTypeMap = new Map([]);
  /**
   *
   * @param {string} innerArgType
   * @param {string} innerArgName
   * @param {Documentation.Member} argument
   * @param {boolean} isExploded
   */
  function pushArg(innerArgType, innerArgName, argument, isExploded = false) {
    const isNullable = nullableTypes.includes(innerArgType);
    const requiredPrefix = (argument.required || isExploded) ? "" : isNullable ? "?" : "";
    const requiredSuffix = (argument.required || isExploded) ? "" : " = default";
    var push = `${innerArgType}${requiredPrefix} ${innerArgName}${requiredSuffix}`;
    if (isExploded)
      explodedArgs.push(push)
    else
      args.push(push);
    argTypeMap.set(push, innerArgName);
  }

  /**
   * @param {Documentation.Member} arg
   */
  function processArg(arg) {
    if (arg.name === "options") {
      arg.type.properties.forEach(processArg);
      return;
    }

    if (arg.type.expression === '[string]|[path]') {
      let argName = toArgumentName(arg.name);
      pushArg("string", `${argName} = null`, arg);
      pushArg("string", `${argName}Path = null`, arg);
      if (arg.spec) {
        addParamsDoc(argName, XmlDoc.renderTextOnly(arg.spec, maxDocumentationColumnWidth));
        addParamsDoc(`${argName}Path`, [`Instead of specifying <paramref name="${argName}"/>, gives the file name to load from.`]);
      }
      return;
    } else if (arg.type.expression === '[boolean]|[Array]<[string]>') {
      // HACK: this hurts my brain too
      // we split this into two args, one boolean, with the logical name
      let argName = toArgumentName(arg.name);
      let leftArgType = translateType(arg.type.union[0], parent, (t) => { throw new Error('Not supported'); });
      let rightArgType = translateType(arg.type.union[1], parent, (t) => { throw new Error('Not supported'); });

      pushArg(leftArgType, argName, arg);
      pushArg(rightArgType, `${argName}Values`, arg);

      addParamsDoc(argName, XmlDoc.renderTextOnly(arg.spec, maxDocumentationColumnWidth));
      addParamsDoc(`${argName}Values`, [`The values to take into account when <paramref name="${argName}"/> is <code>true</code>.`]);

      return;
    }

    const argName = toArgumentName(arg.alias || arg.name);
    const argType = translateType(arg.type, parent, (t) => generateNameDefault(member, argName, t, parent));

    if (argType === null && arg.type.union) {
      // we might have to split this into multiple arguments
      let translatedArguments = arg.type.union.map(t => translateType(t, parent, (x) => generateNameDefault(member, argName, x, parent)));
      if (translatedArguments.includes(null))
        throw new Error('Unexpected null in translated argument types. Aborting.');

      let argDocumentation = XmlDoc.renderTextOnly(arg.spec, maxDocumentationColumnWidth);
      for (const newArg of translatedArguments) {
        let nonGenericType = newArg.replace(/\IEnumerable<(.*)\>/g, (m, v) => 'Enumerable' + v[0].toUpperCase() + v.substring(1))
        const sanitizedArgName = nonGenericType.match(/(?<=^[\s"']*)(\w+)/g, '')[0] || nonGenericType;
        const newArgName = `${argName}${sanitizedArgName[0].toUpperCase() + sanitizedArgName.substring(1)}`;
        pushArg(newArg, newArgName, arg, true); // push the exploded arg
        addParamsDoc(newArgName, argDocumentation);
      }
      args.push(arg.required ? 'EXPLODED_ARG' : 'OPTIONAL_EXPLODED_ARG');
      return;
    }

    addParamsDoc(argName, XmlDoc.renderTextOnly(arg.spec, maxDocumentationColumnWidth));

    if (argName === 'timeout' && argType === 'decimal') {
      args.push(`int timeout = 0`); // a special argument, we ignore our convention
      return;
    }

    pushArg(argType, argName, arg);
  }

  member.argsArray
    .sort((a, b) => b.alias === 'options' ? -1 : 0) //move options to the back to the arguments list
    .forEach(processArg);

  if (name.includes('WaitFor') && !['WaitForTimeoutAsync', 'WaitForFunctionAsync', 'WaitForLoadStateAsync', 'WaitForURLAsync', 'WaitForSelectorAsync', 'WaitForElementStateAsync'].includes(name)) {
    const firstOptional = args.find(a => a.includes('='));
    args.splice(args.indexOf(firstOptional), 0, 'Func<Task> action = default');
    argTypeMap.set('Func<Task> action = default', 'action');
    addParamsDoc('action', ['Action to perform while waiting']);
  }

  if (!explodedArgs.length) {
    out.push(...XmlDoc.renderXmlDoc(member.spec, maxDocumentationColumnWidth));
    paramDocs.forEach((value, i) => printArgDoc(i, value, out));
    out.push(`${type} ${name}(${args.join(', ')});`);
  } else {
    let containsOptionalExplodedArgs = false;
    explodedArgs.forEach((explodedArg, argIndex) => {
      out.push(...XmlDoc.renderXmlDoc(member.spec, maxDocumentationColumnWidth));
      let overloadedArgs = [];
      for (var i = 0; i < args.length; i++) {
        let arg = args[i];
        if (arg === 'EXPLODED_ARG' || arg === 'OPTIONAL_EXPLODED_ARG') {
          containsOptionalExplodedArgs = arg === 'OPTIONAL_EXPLODED_ARG';
          let argType = argTypeMap.get(explodedArg);
          printArgDoc(argType, paramDocs.get(argType), out);
          overloadedArgs.push(explodedArg);
        } else {
          let argType = argTypeMap.get(arg);
          printArgDoc(argType, paramDocs.get(argType), out);
          overloadedArgs.push(arg);
        }
      }
      out.push(`${type} ${name}(${overloadedArgs.join(', ')});`);
      if (argIndex < explodedArgs.length - 1)
        out.push(''); // output a special blank line
    });

    // If the exploded union arguments are optional, we also output a special
    // signature, to help prevent compilation errors with ambiguous overloads.
    // That particular overload only contains the required arguments, or rather
    // contains all the arguments *except* the exploded ones.
    if (containsOptionalExplodedArgs) {
      var filteredArgs = args.filter(x => x !== 'OPTIONAL_EXPLODED_ARG');
      out.push(...XmlDoc.renderXmlDoc(member.spec, maxDocumentationColumnWidth));
      filteredArgs.forEach((arg) => {
        if (arg === 'EXPLODED_ARG')
          throw new Error(`Unsupported required union arg combined an optional union inside ${member.name}`);
        let argType = argTypeMap.get(arg);
        printArgDoc(argType, paramDocs.get(argType), out);
      });
      out.push(`${type} ${name}(${filteredArgs.join(', ')});`);
    }
  }
}

/**
 *
 *  @param {Documentation.Type} type
 *  @param {Documentation.Class|Documentation.Type} parent
 *  @param {generateNameCallback} generateNameCallback
 *  @callback generateNameCallback
 *  @param {Documentation.Type} t
 *  @returns {string}
*/
function translateType(type, parent, generateNameCallback = t => t.name) {
  // a few special cases we can fix automatically
  if (type.expression === '[null]|[Error]')
    return 'void';
  else if (type.expression === '[boolean]|"mixed"')
    return 'MixedState';

  if (type.union) {
    if (type.union[0].name === 'null' && type.union.length === 2)
      return translateType(type.union[1], parent, generateNameCallback);

    if (type.expression === '[string]|[Buffer]')
      return `byte[]`; // TODO: make sure we implement extension methods for this!
    if (type.expression === '[string]|[float]' || type.expression === '[string]|[float]|[boolean]') {
      console.warn(`${type.name} should be a 'string', but was a ${type.expression}`);
      return `string`;
    }
    if (type.union.length == 2 && type.union[1].name === 'Array' && type.union[1].templates[0].name === type.union[0].name)
      return `IEnumerable<${type.union[0].name}>`; // an example of this is [string]|[Array]<[string]>
    if (type.expression === '[float]|"raf"')
      return `Polling`; // hardcoded because there's no other way to denote this

    // Regular primitive enums are named in the markdown.
    if (type.name) {
      enumTypes.set(type.name, type.union.map(t => t.name));
      return type.name;
    }
    return null;
  }

  if (type.name === 'Array') {
    if (type.templates.length != 1)
      throw new Error(`Array (${type.name} from ${parent.name}) has more than 1 dimension. Panic.`);

    let innerType = translateType(type.templates[0], parent, generateNameCallback);
    return `IEnumerable<${innerType}>`;
  }

  if (type.name === 'Object') {
    // take care of some common cases
    // TODO: this can be genericized
    if (type.templates && type.templates.length == 2) {
      // get the inner types of both templates, and if they're strings, it's a keyvaluepair string, string,
      let keyType = translateType(type.templates[0], parent, generateNameCallback);
      let valueType = translateType(type.templates[1], parent, generateNameCallback);
      return `IEnumerable<KeyValuePair<${keyType}, ${valueType}>>`;
    }

    if ((type.name === 'Object')
      && !type.properties
      && !type.union) {
      return 'object';
    }
    // this is an additional type that we need to generate
    let objectName = generateNameCallback(type);
    if (objectName === 'Object') {
      throw new Error('Object unexpected');
    } else if (type.name === 'Object') {
      registerModelType(objectName, type);
    }
    return objectName;
  }

  if (type.name === 'Map') {
    if (type.templates && type.templates.length == 2) {
      // we map to a dictionary
      let keyType = translateType(type.templates[0], parent, generateNameCallback);
      let valueType = translateType(type.templates[1], parent, generateNameCallback);
      return `Dictionary<${keyType}, ${valueType}>`;
    } else {
      throw 'Map has invalid number of templates.';
    }
  }

  if (type.name === 'function') {
    if (type.expression === '[function]' || !type.args)
      return 'Action'; // super simple mapping

    let argsList = '';
    if (type.args) {
      let translatedCallbackArguments = type.args.map(t => translateType(t, parent, generateNameCallback));
      if (translatedCallbackArguments.includes(null))
        throw new Error('There was an argument we could not parse. Aborting.');

      argsList = translatedCallbackArguments.join(', ');
    }

    if (!type.returnType) {
      // this is an Action
      return `Action<${argsList}>`;
    } else {
      let returnType = translateType(type.returnType, parent, generateNameCallback);
      if (returnType == null)
        throw new Error('Unexpected null as return type.');

      return `Func<${argsList}, ${returnType}>`;
    }
  }

  if (type.templates) {
    // this should mean we have a generic type and we can translate that
    /** @type {string[]} */
    var types = type.templates.map(template => translateType(template, parent));
    return `${type.name}<${types.join(', ')}>`
  }

  // there's a chance this is a name we've already seen before, so check
  // this is also where we map known types, like boolean -> bool, etc.
  let name = classNameMap.get(type.name) || type.name;
  return `${name}`;
}

/**
 * @param {string} typeName
 * @param {Documentation.Type} type
 */
function registerModelType(typeName, type) {
  if (['object', 'string', 'int'].includes(typeName))
    return;

  let potentialType = modelTypes.get(typeName);
  if (potentialType) {
    console.log(`Type ${typeName} already exists, so skipping...`);
    return;
  }

  modelTypes.set(typeName, type);
}

/**
 * @param {string} name
 * @param {string[]} value
 * @param {string[]} out
 */
  function printArgDoc(name, value, out) {
  if (value.length === 1) {
    out.push(`/// <param name="${name}">${value}</param>`);
  } else {
    out.push(`/// <param name="${name}">`);
    out.push(...value.map(l => `/// ${l}`));
    out.push(`/// </param>`);
  }
}
