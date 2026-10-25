/** JSON Schema subset used by local module contracts. Values never appear in diagnostics. */
export function validateConfig(schema, value, location="config") {
  if(!schema) return;
  const fail=reason=>{throw new Error(location+": "+reason);};
  if(schema.enum && !schema.enum.some(item=>Object.is(item,value)))fail("unsupported value");
  const type=Array.isArray(value)?"array":value===null?"null":typeof value;
  if(schema.type && !(schema.type==="integer"?Number.isInteger(value):type===schema.type))fail("expected "+schema.type);
  if(type==="number") {if(!Number.isFinite(value))fail("expected finite number");if(schema.minimum!==undefined&&value<schema.minimum)fail("below minimum");if(schema.maximum!==undefined&&value>schema.maximum)fail("above maximum");}
  if(type==="string") {if(schema.minLength!==undefined&&value.length<schema.minLength)fail("too short");if(schema.maxLength!==undefined&&value.length>schema.maxLength)fail("too long");if(schema.pattern&&!new RegExp(schema.pattern).test(value))fail("invalid format");}
  if(type==="array") {if(schema.maxItems!==undefined&&value.length>schema.maxItems)fail("too many items");for(let i=0;i<value.length;i++)validateConfig(schema.items,value[i],location+"["+i+"]");}
  if(type==="object") {
    for(const key of schema.required || [])if(!Object.hasOwn(value,key))fail("missing field "+key);
    for(const [key,item] of Object.entries(value)) {
      const child=schema.properties?.[key];
      if(!child&&schema.additionalProperties===false)fail("unknown field "+key);
      validateConfig(child || (typeof schema.additionalProperties==="object"?schema.additionalProperties:null),item,location+"."+key);
    }
  }
}
