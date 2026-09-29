import fs from 'node:fs';
import {draftSchema,batchBlindSchema} from '../model-v2.mjs';
const root=new URL('../',import.meta.url);
const legacy=JSON.parse(fs.readFileSync(new URL('schema.json',root),'utf8'));
const v2=structuredClone(legacy);
v2.properties.syllabus_mapping.minItems=1;
v2.properties.student_question.properties.observations.minItems=0;
v2.properties.student_question.properties.observations.maxItems=0;
v2.properties.student_question.properties.table=draftSchema.properties.questions.items.properties.table;
v2.properties.student_question.required.push('table');
for(const [key,spec] of Object.entries({model_version:{type:'string',enum:['science-v2']},title:{type:'string',minLength:1},question_family:draftSchema.properties.questions.items.properties.family,design:draftSchema.properties.questions.items.properties.design,solution_steps:draftSchema.properties.questions.items.properties.answer.properties.steps})) {
  v2.properties[key]=spec;v2.required.push(key);
}
for(const [file,value] of [['draft-schema.json',draftSchema],['batch-blind-schema.json',batchBlindSchema],['schema-v2.json',v2]])fs.writeFileSync(new URL(file,root),JSON.stringify(value,null,2)+'\n');
