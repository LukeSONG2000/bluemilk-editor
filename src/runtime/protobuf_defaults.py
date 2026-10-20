"""Materialize omitted struct defaults from the original Protos metadata.

Wire transformation only: never infer missing messages, overwrite explicit values,
or repair legacy captures already corrupted by DeepClone. Not a game-rule engine.
"""
import argparse
import json
import re
import struct
import hashlib
from pathlib import Path


def write_schema_bundle(dump, destination):
    """Cache the exact parsed original metadata, never inferred game rules."""
    schemas = schema_from_dump(dump)
    payload = json.dumps(schemas, sort_keys=True, separators=(',', ':'))
    record = dict(format='original-protos-schema-v1',
                  sourceSha256=hashlib.sha256(Path(dump).read_bytes()).hexdigest(),
                  payloadSha256=hashlib.sha256(payload.encode()).hexdigest(), payload=payload)
    Path(destination).write_text(json.dumps(record), encoding='utf8')
    return record


def read_schema_bundle(path):
    record = json.loads(Path(path).read_text(encoding='utf8'))
    if (record.get('format') != 'original-protos-schema-v1'
            or not re.fullmatch('[0-9a-f]{64}', record.get('sourceSha256', ''))
            or not isinstance(record.get('payload'), str)
            or hashlib.sha256(record['payload'].encode()).hexdigest() != record.get('payloadSha256')):
        raise ValueError('Invalid original schema bundle')
    schemas = {name: {int(tag): field for tag, field in fields.items()}
               for name, fields in json.loads(record['payload']).items()}
    if not all(name in schemas for name in ('BattleData', 'Inventory', 'Stat', 'BucketItem')):
        raise ValueError('Original schema bundle missing required types')
    return schemas, record['sourceSha256']


def schema_from_dump(path):
    text = Path(path).read_text(encoding='utf-8-sig')
    blocks = re.findall(r'^namespace Protos\s*\n\{\n(.*?)^\}', text, re.M | re.S)
    blocks = [f'public {kind} {name}\n{body}'
              for namespace in blocks
              for kind, name, body in re.findall(
                  r'^\tpublic (class|struct|enum) (\w+)[^\n]*\n\t\{\n(.*?)^\t\}',
                  namespace, re.M | re.S)]
    enums, messages = {}, {}
    for block in blocks:
        match = re.search(r'public enum (\w+)', block)
        if match:
            enums[match[1]] = dict((k, int(v)) for k, v in re.findall(r'^\s+(\w+) = (-?\d+),?$', block, re.M))
    for block in blocks:
        match = re.search(r'public (class|struct) (\w+)', block)
        if not match:
            continue
        kind, name = match.groups()
        fields = {}
        attributes = []
        for line in block.splitlines():
            line = line.strip()
            if line.startswith('['):
                attributes.append(line)
                continue
            member = re.match(r'public ([\w.]+(?:<[^>]+>)?(?:\[\])?) (\w+)(?:;| \{)', line)
            attrs = '\n'.join(attributes)
            tag = re.search(r'ProtoMember\((\d+),', attrs)
            if member and tag:
                field_type, field_name = member.groups()
                repeated = field_type.startswith('List<')
                if repeated:
                    field_type = field_type[5:-1]
                field_type = field_type.removeprefix('Protos.')
                default = re.search(r'DefaultValue\((.*?)\)\]', attrs)
                item = {'type': field_type, 'name': field_name, 'repeated': repeated}
                if kind == 'struct' and default and not repeated:
                    value = default[1]
                    if value != 'null':
                        if value.startswith('"'):
                            value = json.loads(value)
                        elif value in ('true', 'false'):
                            value = value == 'true'
                        elif '.' in value and field_type in enums:
                            value = enums[field_type][value.rsplit('.', 1)[1]]
                        elif field_type in ('float', 'double'):
                            value = float(value.rstrip('fFdD'))
                        else:
                            value = int(value)
                        item['default'] = value
                fields[int(tag[1])] = item
            attributes = []
        if fields:
            messages[name] = fields
    if not all(name in messages for name in ('BattleData', 'Stat', 'BucketItem')):
        raise ValueError('Original schema missing required types')
    return messages


def varint(value):
    value &= (1 << 64) - 1
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def read_varint(data, offset):
    value = 0
    for i in range(10):
        if offset >= len(data):
            raise ValueError('Truncated varint')
        byte = data[offset]
        offset += 1
        if i == 9 and byte > 1:
            raise ValueError('Varint overflow')
        value |= (byte & 127) << (7 * i)
        if byte < 128:
            return value, offset
    raise ValueError('Varint overflow')


def encode_default(tag, field):
    value, kind = field['default'], field['type']
    if kind == 'string':
        payload = value.encode('utf-8')
        return varint(tag * 8 + 2) + varint(len(payload)) + payload
    if kind in ('float', 'double'):
        wire, fmt = (5, '<f') if kind == 'float' else (1, '<d')
        return varint(tag * 8 + wire) + struct.pack(fmt, value)
    return varint(tag * 8) + varint(int(value))


def materialize(data, type_name, schemas, depth=0):
    if depth > 64 or len(data) > 16 * 1024 * 1024:
        raise ValueError('Message exceeds bounds')
    fields = schemas[type_name]
    seen, out, offset = set(), bytearray(), 0
    while offset < len(data):
        start = offset
        key, offset = read_varint(data, offset)
        tag, wire = key >> 3, key & 7
        if not tag:
            raise ValueError('Invalid protobuf tag')
        seen.add(tag)
        field = fields.get(tag)
        if wire == 2:
            length, begin = read_varint(data, offset)
            offset = begin + length
            if offset > len(data):
                raise ValueError('Truncated message')
            if field and field['type'] in schemas:
                child = materialize(data[begin:offset], field['type'], schemas, depth + 1)
                out.extend(varint(key) + varint(len(child)) + child)
                continue
        elif wire == 0:
            _, offset = read_varint(data, offset)
        elif wire in (1, 5):
            offset += 8 if wire == 1 else 4
        else:
            raise ValueError('Unsupported wire type; refusing lossy conversion')
        if offset > len(data):
            raise ValueError('Truncated field')
        out.extend(data[start:offset])
    for tag, field in fields.items():
        if tag not in seen and 'default' in field:
            out.extend(encode_default(tag, field))
    return bytes(out)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dump', required=True)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--type', default='BattleData')
    args = parser.parse_args()
    schemas = schema_from_dump(args.dump)
    source = Path(args.input).read_bytes()
    result = materialize(source, args.type, schemas)
    with Path(args.output).open('xb') as destination:
        destination.write(result)
    print(json.dumps({'type': args.type, 'inputBytes': len(source), 'outputBytes': len(result)}))
