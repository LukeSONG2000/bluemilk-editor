"""BlueMilk configuration form v1; deliberately a bounded schema, not JSON Schema."""
import re
import json


def validate_value(field, value):
    kind = field['type']
    if kind == 'boolean':
        valid = type(value) is bool
    elif kind == 'integer':
        valid = type(value) is int and field['minimum'] <= value <= field['maximum']
    else:
        valid = type(value) is str and len(value) <= field['maxLength']
        if 'options' in field:
            valid = valid and value in field['options']
    if not valid:
        raise ValueError('Invalid configuration value: ' + field['key'])


def validate_schema(schema):
    if (type(schema) is not dict or set(schema) != {'version', 'fields'}
            or type(schema['version']) is not int or schema['version'] != 1
            or type(schema['fields']) is not list or not 1 <= len(schema['fields']) <= 32):
        raise ValueError('Invalid configuration schema v1')
    seen = set()
    for field in schema['fields']:
        if type(field) is not dict:
            raise ValueError('Invalid configuration field')
        common = {'key', 'label', 'type', 'default'}
        kind = field.get('type')
        extra = {'minimum', 'maximum'} if kind == 'integer' else {'maxLength', 'options'} if kind == 'string' else set()
        if kind not in ('boolean', 'integer', 'string') or not common <= set(field) or set(field) - common - extra:
            raise ValueError('Unsupported configuration field')
        key = field['key']
        if (type(key) is not str or not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]{0,63}', key)
                or key in seen or key in ('constructor', 'prototype', '__proto__')):
            raise ValueError('Invalid or duplicate configuration key')
        seen.add(key)
        if type(field['label']) is not str or not field['label'].strip() or len(field['label']) > 128:
            raise ValueError('Invalid configuration label')
        if kind == 'integer':
            if (any(type(field.get(k)) is not int for k in ('minimum', 'maximum'))
                    or not -9007199254740991 <= field['minimum'] <= field['maximum'] <= 9007199254740991):
                raise ValueError('Invalid integer bounds')
        if kind == 'string':
            if type(field.get('maxLength')) is not int or not 1 <= field['maxLength'] <= 1024:
                raise ValueError('Invalid string limit')
            if 'options' in field:
                options = field['options']
                if (type(options) is not list or not 1 <= len(options) <= 32
                        or any(type(x) is not str or len(x) > field['maxLength'] for x in options)
                        or len(set(options)) != len(options)):
                    raise ValueError('Invalid configuration choices')
        validate_value(field, field['default'])
    defaults = {field['key']: field['default'] for field in schema['fields']}
    if len(json.dumps(defaults, ensure_ascii=True, separators=(',', ':')).encode('ascii')) > 8192:
        raise ValueError('Configuration defaults exceed 8 KiB')
    return schema


def resolve(schema, values):
    if schema is None:
        return values
    validate_schema(schema)
    if type(values) is not dict or set(values) - {f['key'] for f in schema['fields']}:
        raise ValueError('Unknown configuration field')
    result = {}
    for field in schema['fields']:
        value = values.get(field['key'], field['default'])
        validate_value(field, value)
        result[field['key']] = value
    return result
