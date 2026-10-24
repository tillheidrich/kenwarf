// node --test deploy/egress/adressen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adresseGesperrt } from './kern-egress.mjs';

const gesperrt = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '169.254.169.254', '0.0.0.0',
  '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fd00:ec2::254', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
  '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '2001:db8::1', '2001:0:4136:e378::1'];
const frei = ['1.1.1.1', '8.8.8.8', '11.22.33.10', '172.32.0.1', '192.169.0.1', '2a01:4f8::1', '2606:4700::1111', '::ffff:1.1.1.1', '64:ff9b::808:808'];

test('gesperrte Adressen', () => { for (const ip of gesperrt) assert.ok(adresseGesperrt(ip), ip); });
test('öffentliche Adressen', () => { for (const ip of frei) assert.equal(adresseGesperrt(ip), null, ip); });
test('keine IP', () => { assert.equal(adresseGesperrt('example.com'), 'keine_ip'); });
