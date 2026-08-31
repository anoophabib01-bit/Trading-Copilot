// READ-ONLY diagnostic. Connects to every CDP page target and asks each one
// where the broker tables actually are. Clicks nothing, changes nothing.
import CDP from 'chrome-remote-interface';

const JS = `(function(){
  function q(sel){ try { return document.querySelectorAll(sel).length; } catch(e){ return -1; } }
  var bottom = document.querySelector('[class*="layout__data-window"], [class*="layout__area--bottom"]');
  var tables = Array.prototype.slice.call(document.querySelectorAll('table[data-name]'))
    .map(function(t){ return t.getAttribute('data-name'); }).slice(0, 20);
  var anyTable = document.querySelectorAll('table').length;
  var txt = (document.body ? (document.body.innerText || '') : '');
  return {
    title: document.title.slice(0, 60),
    href: location.href.slice(0, 90),
    bottomAreaPresent: !!bottom,
    bottomAreaHeight: bottom ? bottom.clientHeight : 0,
    tablesWithDataName: tables,
    totalTables: anyTable,
    mentionsTradovate: /Tradovate/i.test(txt),
    mentionsAccountBalance: /Account Balance/i.test(txt),
    layoutBottomCount: q('[class*="layout__area--bottom"]')
  };
})()`;

const list = await CDP.List({ port: 9222 });
const pages = list.filter(t => t.type === 'page');
for (const t of pages) {
  let client;
  try {
    client = await CDP({ target: t, port: 9222 });
    const { Runtime } = client;
    await Runtime.enable();
    const r = await Runtime.evaluate({ expression: JS, returnByValue: true, awaitPromise: false });
    const v = r.result && r.result.value;
    if (v) {
      console.log('\n--- target:', (t.title || '(no title)').slice(0, 50));
      console.log('   url               :', v.href);
      console.log('   layout__area--bottom present:', v.bottomAreaPresent, '(count ' + v.layoutBottomCount + ', height ' + v.bottomAreaHeight + ')');
      console.log('   tables total      :', v.totalTables);
      console.log('   table[data-name]  :', JSON.stringify(v.tablesWithDataName));
      console.log('   says "Tradovate"  :', v.mentionsTradovate, '| says "Account Balance":', v.mentionsAccountBalance);
    }
  } catch (e) {
    console.log('\n--- target:', (t.title || '(no title)').slice(0, 40), '-> could not evaluate:', e.message);
  } finally {
    if (client) try { await client.close(); } catch (e) {}
  }
}
process.exit(0);
