const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, '..', '_local_assets');

// Directories to create
const dirs = [
  'HTTP Status Codes',
  'Performance Lab',
  'XML Formatter',
  'XML & Text Sanitizer',
  'Base64 - URL Encoder', // Replacing / with - for directory name
  'Markdown & Table Generator'
];

dirs.forEach(d => {
  const p = path.join(baseDir, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// 1. Performance Lab - JS snippet showing list processing
const perfCode = `// Performance Test: Map vs For-Loop vs Mendix Iterator Mock
const items = Array.from({ length: 150000 }, (_, i) => ({
  id: 'ORD-' + i,
  status: i % 5 === 0 ? 'PENDING' : 'DELIVERED',
  amount: Math.random() * 5000,
  isArchived: false
}));

function testNativeMap() {
  return items.map(item => ({ ...item, isArchived: item.status === 'DELIVERED' }));
}

function testNativeForLoop() {
  const result = [];
  for(let i = 0; i < items.length; i++) {
    result.push({
      ...items[i],
      isArchived: items[i].status === 'DELIVERED'
    });
  }
  return result;
}`;
fs.writeFileSync(path.join(baseDir, 'Performance Lab', 'mendix_list_processing_PerformanceTab.js'), perfCode);

// 2. XML Formatter - Complex SOAP Envelope
const xmlCode = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soap:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><wsse:UsernameToken><wsse:Username>MendixUser</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">SecretP@ss</wsse:Password></wsse:UsernameToken></wsse:Security></soap:Header><soap:Body><ns2:SyncSalesOrderResponse xmlns:ns2="http://enterprise.sap.com/ERP/Sales/"><ns2:SalesOrder><ns2:ID>90012456</ns2:ID><ns2:Status>PROCESSED</ns2:Status><ns2:CustomerName>Tech Corp Innovations</ns2:CustomerName><ns2:Items><ns2:Item><ns2:Position>10</ns2:Position><ns2:Material>ITM-LAPTOP-X2</ns2:Material><ns2:Quantity>50</ns2:Quantity><ns2:NetPrice>1250.00</ns2:NetPrice></ns2:Item></ns2:Items></ns2:SalesOrder></ns2:SyncSalesOrderResponse></soap:Body></soap:Envelope>`;
fs.writeFileSync(path.join(baseDir, 'XML Formatter', 'sap_invoice_response_FormatterTab.xml'), xmlCode);

// 3. XML & Text Sanitizer - Dirty export
const dirtyXml = `<?xml version="1.0"?>
<DataExport>
  <!-- Record with invisible unicode control chars -->
  <Record ID="1234\u0000\u0001\u0003">
    <Name>Mendix \u000B Export Data \u001A</Name>
    <Description>This contains vertical tabs\u000B and form feeds\u000C which break the Mx parser.</Description>
  </Record>
</DataExport>`;
fs.writeFileSync(path.join(baseDir, 'XML & Text Sanitizer', 'dirty_mendix_export_SanitizeTab.xml'), dirtyXml);

// 4. Base64 Encoder
const b64Data = `{"alg":"HS256","typ":"JWT"}.{"sub":"1234567890","name":"Mendix Administrator","iat":1516239022,"roles":["admin","financial_controller","hr_manager"],"companyId":"CP-981245"}`;
fs.writeFileSync(path.join(baseDir, 'Base64 - URL Encoder', 'jwt_token_payload_EncoderTab.txt'), b64Data);

// 5. Markdown Generator - CSV
const csvData = `EntityName,AttributeName,DataType,Description,IsIndexed
Sales.Order,OrderNumber,String,"Unique identifier for the order, synced from ERP",Yes
Sales.Order,TotalPrice,Decimal,"Calculated total price including taxes",No
Sales.Order,OrderStatus,Enum,"Current state in the state machine",Yes
CRM.Customer,FullName,String,"Concat of First and Last Name",No
CRM.Customer,Email,String,"Primary contact email",Yes`;
fs.writeFileSync(path.join(baseDir, 'Markdown & Table Generator', 'entities_export_GeneratorTab.csv'), csvData);

// 6. HTTP Status
const statusSearch = `503`;
fs.writeFileSync(path.join(baseDir, 'HTTP Status Codes', 'sample_query_SearchTab.txt'), statusSearch);

console.log('Missing data generated.');
