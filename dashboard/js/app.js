// =============================================================================
// Mercado Libre OTD Dashboard — main script
// Carga dashboard_data.json y renderiza KPIs, tablas y gráficos con Chart.js.
// =============================================================================

const ML_YELLOW       = '#FFE600';
const ML_YELLOW_DARK  = '#E5CE00';
const ML_BLUE         = '#2D3277';
const ML_BLUE_LIGHT   = '#4A51A8';
const ML_OK           = '#00A650';
const ML_WARN         = '#F59E0B';
const ML_DANGER       = '#E63946';
const INK_DIM         = '#8A8FA6';
const RULE            = '#E4E6F0';

// Config global de Chart.js
Chart.defaults.color = '#4B4E6B';
Chart.defaults.borderColor = RULE;
Chart.defaults.font.family = "'JetBrains Mono', 'Menlo', monospace";
Chart.defaults.font.size = 11;

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------
(async function init() {
    try {
        const res = await fetch('./data/dashboard_data.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const DATA = await res.json();
        window.__OTD_DATA__ = DATA; // expose for debugging
        render(DATA);
    } catch (err) {
        document.body.innerHTML = `<div class="loading">Error cargando datos: ${err.message}. Asegúrate de servir el dashboard con un servidor HTTP (ej. <code>python -m http.server</code>).</div>`;
    }
})();

// -----------------------------------------------------------------------------
// Render orchestrator
// -----------------------------------------------------------------------------
function render(DATA) {
    renderKPIs(DATA.kpis);
    renderStages(DATA.por_destino);
    renderTabla(DATA.por_destino);
    renderScatter(DATA.scatter);
    renderCorr(DATA.por_destino);
    renderTrend(DATA.tendencia);
    renderBoxplots(DATA.boxplots);
    renderHeatmap(DATA.heatmap, DATA.por_destino);
    renderDoblesKPIs(DATA.fechas_dobles);
    renderDoblesComp(DATA.fechas_dobles);
    renderDoblesEtapas(DATA.fechas_dobles);
    renderDoblesTablas(DATA.fechas_dobles);
    renderFI(DATA.feature_importance);
    renderMLMetrics(DATA.kpis);
}

// -----------------------------------------------------------------------------
// KPI bar
// -----------------------------------------------------------------------------
function renderKPIs(k) {
    document.getElementById('kpi-early').textContent = k.pct_early;
    document.getElementById('kpi-adelanto').textContent = (k.adelanto_medio_h / 24).toFixed(1);
    document.getElementById('kpi-ontime').textContent = k.pct_ontime;
    document.getElementById('kpi-delayed').textContent = k.pct_delayed;
    document.getElementById('kpi-total-envios').textContent = k.total_envios.toLocaleString();
}

// -----------------------------------------------------------------------------
// Stages by destination
// -----------------------------------------------------------------------------
function renderStages(destinos) {
    const container = document.getElementById('stages-container');
    const max = Math.max(...destinos.map(d => d.t_promesa));
    destinos.forEach(d => {
        const prep = (d.t_preparacion / max * 100).toFixed(1);
        const lhl  = (d.t_linehaul    / max * 100).toFixed(1);
        const um   = (d.t_ultima_milla/ max * 100).toFixed(1);
        const prom = (d.t_promesa     / max * 100).toFixed(1);
        container.insertAdjacentHTML('beforeend', `
            <div class="stage-row">
                <div>
                    <div class="dest-name">${d.nombre}</div>
                    <div class="dest-region">${d.region} · ${d.envios} envíos</div>
                </div>
                <div>
                    <div class="stage-bar">
                        <span class="stage-prep" style="width:${prep}%">${d.t_preparacion}h</span>
                        <span class="stage-lhl"  style="width:${lhl}%">${d.t_linehaul}h</span>
                        <span class="stage-um"   style="width:${um}%">${d.t_ultima_milla}h</span>
                    </div>
                    <div class="stage-promesa" style="width:${prom}%"></div>
                </div>
                <div class="stage-total">
                    ${d.t_total_real}h
                    <small>promesa ${d.t_promesa}h</small>
                </div>
            </div>
        `);
    });
}

// -----------------------------------------------------------------------------
// Destinations table
// -----------------------------------------------------------------------------
function renderTabla(destinos) {
    const tbody = document.getElementById('tabla-destinos');
    destinos.forEach(d => {
        const cls = d.pct_early > 85 ? 'danger' : d.pct_early > 75 ? 'warn' : 'ok';
        tbody.insertAdjacentHTML('beforeend', `
            <tr>
                <td>${d.nombre}</td>
                <td>${d.envios.toLocaleString()}</td>
                <td>${d.t_total_real}h</td>
                <td>${d.p90_real}h</td>
                <td>${d.t_promesa}h</td>
                <td><span class="pill ${cls}">${d.pct_early}%</span></td>
            </tr>
        `);
    });
}

// -----------------------------------------------------------------------------
// Scatter: promesa vs tiempo real (diagnóstico de promesa del PDF)
// -----------------------------------------------------------------------------
function renderScatter(scatter) {
    const colorMap = {
        'Early':   ML_YELLOW_DARK,
        'On-Time': ML_OK,
        'Delayed': ML_DANGER
    };
    const datasets = ['Early', 'On-Time', 'Delayed'].map(status => ({
        label: status,
        data: scatter.filter(p => p.delivery_status === status)
                     .map(p => ({ x: p.t_promesa_h, y: p.t_total_real_h })),
        backgroundColor: colorMap[status] + 'BB',
        borderColor: colorMap[status],
        pointRadius: 3,
        pointHoverRadius: 5
    }));

    // Línea y=x
    const maxVal = Math.max(...scatter.map(p => Math.max(p.t_promesa_h, p.t_total_real_h)));
    datasets.push({
        label: 'Entrega perfecta (y = x)',
        type: 'line',
        data: [{x: 0, y: 0}, {x: maxVal, y: maxVal}],
        borderColor: ML_BLUE,
        borderDash: [6, 4],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        showLine: true
    });

    new Chart(document.getElementById('chartScatter'), {
        type: 'scatter',
        data: { datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top', labels: { boxWidth: 12, padding: 14 } },
                tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: promesa ${ctx.parsed.x}h · real ${ctx.parsed.y}h` } }
            },
            scales: {
                x: { title: { display: true, text: 'Promesa (h)', color: ML_BLUE, font: { weight: 700 } }, grid: { color: RULE } },
                y: { title: { display: true, text: 'Tiempo real (h)', color: ML_BLUE, font: { weight: 700 } }, grid: { color: RULE } }
            }
        }
    });
}

// -----------------------------------------------------------------------------
// Correlation bar
// -----------------------------------------------------------------------------
function renderCorr(destinos) {
    // Volumen por destino como proxy del patrón
    new Chart(document.getElementById('chartCorr'), {
        type: 'bar',
        data: {
            labels: destinos.map(d => d.nombre),
            datasets: [
                { label: '% Early',   data: destinos.map(d => d.pct_early),   backgroundColor: ML_YELLOW },
                { label: '% On-Time', data: destinos.map(d => d.pct_ontime),  backgroundColor: ML_BLUE },
                { label: '% Delayed', data: destinos.map(d => d.pct_delayed), backgroundColor: ML_DANGER }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } } },
            scales: {
                x: { grid: { display: false } },
                y: { beginAtZero: true, max: 100, grid: { color: RULE }, ticks: { callback: v => v + '%' } }
            }
        }
    });
}

// -----------------------------------------------------------------------------
// Weekly trend line
// -----------------------------------------------------------------------------
function renderTrend(tendencia) {
    new Chart(document.getElementById('chartTrend'), {
        type: 'line',
        data: {
            labels: tendencia.map(d => d.semana),
            datasets: [
                { label: 'Early',   data: tendencia.map(d => d.Early),   borderColor: ML_YELLOW_DARK, backgroundColor: ML_YELLOW + '33', tension: 0.35, pointRadius: 3, fill: false },
                { label: 'On-Time', data: tendencia.map(d => d.OnTime),  borderColor: ML_OK,          backgroundColor: ML_OK + '22',      tension: 0.35, pointRadius: 3, fill: false },
                { label: 'Delayed', data: tendencia.map(d => d.Delayed), borderColor: ML_DANGER,      backgroundColor: ML_DANGER + '22',  tension: 0.35, pointRadius: 3, fill: false }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } } },
            scales: {
                y: { beginAtZero: true, max: 100, grid: { color: RULE }, ticks: { callback: v => v + '%' } },
                x: { grid: { display: false } }
            }
        }
    });
}

// -----------------------------------------------------------------------------
// Boxplots segmentados por etapa (simulados con barras de rango)
// -----------------------------------------------------------------------------
function renderBoxplots(boxplots) {
    const etapas = [...new Set(boxplots.map(b => b.etapa))];
    const destinos = [...new Set(boxplots.map(b => b.destino))];
    const palette = [ML_BLUE_LIGHT, ML_BLUE, ML_YELLOW_DARK];

    // Para cada destino: barra apilada que muestra [min→q1, q1→q3, q3→max] coloreada
    const datasets = destinos.map((dest, i) => {
        const seriesMin = etapas.map(e => {
            const b = boxplots.find(x => x.destino === dest && x.etapa === e);
            return b ? [b.min, b.max] : null;
        });
        const seriesQ = etapas.map(e => {
            const b = boxplots.find(x => x.destino === dest && x.etapa === e);
            return b ? [b.q1, b.q3] : null;
        });
        const seriesMedian = etapas.map(e => {
            const b = boxplots.find(x => x.destino === dest && x.etapa === e);
            return b ? b.median : null;
        });
        return [
            { label: `${dest} — P5-P95`,  data: seriesMin, backgroundColor: palette[i] + '33', borderColor: palette[i], borderWidth: 1, stack: dest, borderSkipped: false, borderRadius: 0 },
            { label: `${dest} — P25-P75`, data: seriesQ,   backgroundColor: palette[i] + 'CC', borderColor: palette[i], borderWidth: 1, stack: dest, borderSkipped: false, borderRadius: 2 },
            { label: `${dest} — Mediana`, data: seriesMedian.map(m => m === null ? null : [m - 0.3, m + 0.3]), backgroundColor: '#151628', borderColor: '#151628', borderWidth: 0, stack: dest, borderSkipped: false }
        ];
    }).flat();

    new Chart(document.getElementById('chartBoxplots'), {
        type: 'bar',
        data: { labels: etapas, datasets },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10, filter: item => !item.text.includes('Mediana') } },
                tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw[0]}h → ${ctx.raw[1]}h` } }
            },
            scales: {
                x: { grid: { color: RULE }, title: { display: true, text: 'Horas', color: ML_BLUE, font: { weight: 700 } } },
                y: { grid: { display: false } }
            }
        }
    });
}

// -----------------------------------------------------------------------------
// Heatmap de OCC por SC y día (simulado con puntos coloreados en scatter)
// -----------------------------------------------------------------------------
function renderHeatmap(heatmap, destinos) {
    const sites = destinos.map(d => d.site_id);
    const fechas = [...new Set(heatmap.map(h => h.fecha_dia))].sort();

    const datasets = sites.map((siteId, idx) => {
        const dest = destinos.find(d => d.site_id === siteId);
        return {
            label: dest.nombre,
            data: heatmap.filter(h => h.destino_site_id === siteId).map(h => ({
                x: h.fecha_dia,
                y: siteId,
                r: 4 + (h.envios || 1) / 2,
                occ: h.occ,
                ds: h.ds
            })),
            backgroundColor: ctx => {
                const occ = ctx.raw?.occ ?? 90;
                if (occ < 80) return ML_DANGER + 'CC';
                if (occ < 90) return ML_WARN + 'CC';
                return ML_OK + 'CC';
            },
            borderColor: ML_BLUE,
            borderWidth: 0.5
        };
    });

    new Chart(document.getElementById('chartHeatmap'), {
        type: 'bubble',
        data: { datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: {
                    title: ctx => ctx[0].raw.x,
                    label: ctx => [`${ctx.dataset.label}`, `OCC: ${ctx.raw.occ}%`, `DS: ${ctx.raw.ds}%`]
                } }
            },
            scales: {
                x: { type: 'category', labels: fechas, grid: { display: false }, ticks: { maxTicksLimit: 12, color: INK_DIM } },
                y: { type: 'category', labels: sites, grid: { color: RULE }, ticks: { color: ML_BLUE, font: { weight: 700 } } }
            }
        }
    });
}

// -----------------------------------------------------------------------------
// Fechas dobles
// -----------------------------------------------------------------------------
function renderDoblesKPIs(d) {
    document.getElementById('d-total').textContent = d.total_dobles;
    document.getElementById('d-delayed').textContent = d.dist_dobles.delayed;
    const deltaUm = ((d.tiempos.ultima_milla.dobles / d.tiempos.ultima_milla.resto - 1) * 100).toFixed(0);
    document.getElementById('d-um').textContent = '+' + deltaUm;
}

function renderDoblesComp(d) {
    new Chart(document.getElementById('chartDobles'), {
        type: 'bar',
        data: {
            labels: ['Fechas dobles', 'Resto Q1'],
            datasets: [
                { label: 'Early',   data: [d.dist_dobles.early,   d.dist_resto.early],   backgroundColor: ML_YELLOW, borderRadius: 2 },
                { label: 'On-Time', data: [d.dist_dobles.ontime,  d.dist_resto.ontime],  backgroundColor: ML_OK,     borderRadius: 2 },
                { label: 'Delayed', data: [d.dist_dobles.delayed, d.dist_resto.delayed], backgroundColor: ML_DANGER, borderRadius: 2 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } } },
            scales: {
                x: { stacked: true, grid: { display: false } },
                y: { stacked: true, max: 100, grid: { color: RULE }, ticks: { callback: v => v + '%' } }
            }
        }
    });
}

function renderDoblesEtapas(d) {
    new Chart(document.getElementById('chartDoblesEtapas'), {
        type: 'bar',
        data: {
            labels: ['Preparación', 'Linehaul', 'Última milla', 'Total'],
            datasets: [
                { label: 'Fechas dobles', data: [d.tiempos.preparacion.dobles, d.tiempos.linehaul.dobles, d.tiempos.ultima_milla.dobles, d.tiempos.total.dobles], backgroundColor: ML_YELLOW, borderRadius: 2 },
                { label: 'Resto Q1',      data: [d.tiempos.preparacion.resto,  d.tiempos.linehaul.resto,  d.tiempos.ultima_milla.resto,  d.tiempos.total.resto],  backgroundColor: ML_BLUE,   borderRadius: 2 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } },
                tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw}h` } }
            },
            scales: {
                x: { grid: { display: false } },
                y: { grid: { color: RULE }, ticks: { callback: v => v + 'h' } }
            }
        }
    });
}

function renderDoblesTablas(d) {
    const tbody = document.getElementById('tabla-dobles');
    d.detalle_por_destino.forEach(r => {
        const cls = r.pct_delayed >= 30 ? 'danger' : r.pct_delayed >= 10 ? 'warn' : 'ok';
        tbody.insertAdjacentHTML('beforeend', `
            <tr>
                <td>${r.fecha.slice(5).replace('-','/')}</td>
                <td>${r.sc}</td>
                <td>${r.envios}</td>
                <td>${r.t_ultima_milla_h}h</td>
                <td>${r.pct_early}%</td>
                <td><span class="pill ${cls}">${r.pct_delayed}%</span></td>
            </tr>
        `);
    });
}

// -----------------------------------------------------------------------------
// Feature importance
// -----------------------------------------------------------------------------
function renderFI(fi) {
    new Chart(document.getElementById('chartFI'), {
        type: 'bar',
        data: {
            labels: fi.map(f => f.feature),
            datasets: [{
                label: 'Importance',
                data: fi.map(f => f.importance),
                backgroundColor: fi.map(f => f.importance > 0.2 ? ML_YELLOW : f.importance > 0.1 ? ML_BLUE : ML_BLUE_LIGHT),
                borderRadius: 2,
                barThickness: 22
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { color: RULE } },
                y: { grid: { display: false } }
            }
        }
    });
}

function renderMLMetrics(k) {
    document.getElementById('ml-mae').textContent = k.mae;
    document.getElementById('ml-rmse').textContent = k.rmse;
    document.getElementById('ml-buffer').textContent = k.buffer_2sigma;
}
