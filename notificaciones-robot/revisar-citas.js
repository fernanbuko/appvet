// Este script lo ejecuta GitHub Actions cada cierto tiempo (ver el archivo
// .github/workflows/revisar-citas.yml). Revisa:
//   - Próximas visitas de pacientes (avisa cuando falta poco, con hora exacta)
//   - Próximas dosis de vacunas
//   - Próximas dosis de desparasitación
//   - Próximas revisiones post-quirúrgicas (cirugías)
//   - Próximos baños programados
// y manda una notificación push al celular del doctor/a (o de todo el
// equipo, si el paciente pertenece a una clínica compartida) cuando
// corresponde.
//
// No modifica nada más de la app: solo LEE estos registros y config, y
// ESCRIBE una marca en cada uno para no avisar dos veces por lo mismo.
//
// A propósito, este script NO usa consultas de "grupo de colección"
// (collectionGroup): esas requieren crear un índice especial en Firestore
// que puede ser confuso de configurar a mano. En su lugar, revisa clínica
// por clínica y usuario por usuario, consultando cada colección por
// separado — más lento con MUCHOS usuarios, pero no necesita ninguna
// configuración extra en Firestore.

const admin = require("firebase-admin");

// La llave de servicio viene de un "secreto" de GitHub (nunca se sube al
// repositorio en texto plano). Ver las instrucciones para configurarlo.
const crudo = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
let serviceAccount;
try {
  serviceAccount = JSON.parse(crudo);
} catch (e) {
  console.error("❌ El secreto FIREBASE_SERVICE_ACCOUNT_JSON no se pudo leer como JSON válido.");
  console.error("Longitud recibida (caracteres):", crudo.length);
  console.error("¿Empieza con '{'?:", crudo.trimStart().startsWith("{"));
  console.error("¿Termina con '}'?:", crudo.trimEnd().endsWith("}"));
  console.error("Mensaje del error de parseo:", e.message);
  process.exit(1);
}
if (!serviceAccount.private_key || !serviceAccount.client_email || !serviceAccount.project_id) {
  console.error("❌ El JSON se leyó, pero le faltan campos esperados (private_key, client_email o project_id).");
  console.error("Campos presentes:", Object.keys(serviceAccount).join(", "));
  process.exit(1);
}
console.log("✅ Llave de servicio leída correctamente para el proyecto:", serviceAccount.project_id);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

// Ventana de aviso para citas CON hora exacta: se notifica cuando falten
// entre 0 y 30 minutos. Para vacunas/desparasitación/cirugías/baños (que
// solo tienen fecha, sin hora) se avisa una vez el mismo día que
// corresponde, sin necesitar minutos exactos.
const MINUTOS_VENTANA = 30;

function hoyComoTexto() {
  // Se calcula "qué día es hoy" según la hora de Ecuador (UTC-5), no la del
  // servidor donde corre el robot — para no confundirse cerca de la
  // medianoche.
  const ahoraEcuador = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const y = ahoraEcuador.getUTCFullYear();
  const m = String(ahoraEcuador.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ahoraEcuador.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function minutosHastaLaCita(fechaTexto, horaTexto) {
  const [anio, mes, dia] = fechaTexto.split("-").map(Number);
  const [hora, minuto] = horaTexto.split(":").map(Number);
  const momentoCitaUTC = Date.UTC(anio, mes - 1, dia, hora + 5, minuto, 0);
  const ahoraUTC = Date.now();
  return Math.round((momentoCitaUTC - ahoraUTC) / 60000);
}

// Caché de configuraciones ya leídas en esta misma corrida del robot (se
// vacía sola en cada ejecución, ya que el script termina y vuelve a
// arrancar de cero la próxima vez). Evita leer el mismo documento de
// Firestore una y otra vez: antes se releía la config de cada usuario una
// vez por cada tipo de recordatorio (vacunas, baños, etc.), y ahora además
// hay que leer la config de cada colaborador — sin caché, eso multiplica
// mucho las lecturas.
const configCachePorUid = new Map();
async function configDeUid(uid) {
  if (configCachePorUid.has(uid)) return configCachePorUid.get(uid);
  const doc = await db.collection("users").doc(uid).collection("data").doc("config").get();
  const config = doc.exists ? doc.data()?.value || null : null;
  configCachePorUid.set(uid, config);
  return config;
}

async function tokensDeUsuario(usuarioRef) {
  const config = await configDeUid(usuarioRef.id);
  return config?.fcmTokens || [];
}

async function tokensDeClinica(clinicaId, usuarios) {
  const tokens = [];
  for (const usuarioRef of usuarios) {
    const valor = await configDeUid(usuarioRef.id);
    if (valor?.clinicaId === clinicaId && Array.isArray(valor.fcmTokens)) {
      tokens.push(...valor.fcmTokens);
    }
  }
  return [...new Set(tokens)];
}

// Agrega, al set de tokens que ya se tiene, los de cualquier colaborador de
// acceso limitado (por ejemplo, un peluquero externo) al que el dueño de
// "config" le haya compartido la sección indicada (ej. "banos"). Sin esto,
// las notificaciones de una sección compartida solo le llegaban al dueño de
// la cuenta y nunca al colaborador — aunque en la app sí pueda ver y
// registrar esa sección.
async function agregarTokensDeColaboradoresConSeccion(config, seccion, tokensSet) {
  const colaboradores = config?.colaboradoresPermitidos || {};
  for (const [uidColaborador, info] of Object.entries(colaboradores)) {
    if (!info?.secciones?.includes(seccion)) continue;
    const configColaborador = await configDeUid(uidColaborador);
    (configColaborador?.fcmTokens || []).forEach((t) => tokensSet.add(t));
  }
}

// Igual que tokensDeUsuario, pero incluyendo también a los colaboradores con
// acceso a "seccion" (se usa para los recordatorios por fecha: vacunas,
// desparasitación, cirugías, baños).
async function tokensDeUsuarioConSeccion(usuarioRef, seccion) {
  const config = await configDeUid(usuarioRef.id);
  const tokens = new Set(config?.fcmTokens || []);
  await agregarTokensDeColaboradoresConSeccion(config, seccion, tokens);
  return [...tokens];
}

// Igual que tokensDeClinica, pero incluyendo también a los colaboradores de
// acceso limitado que cualquier miembro del equipo le haya compartido esta
// sección.
async function tokensDeClinicaConSeccion(clinicaId, usuarios, seccion) {
  const tokens = new Set();
  for (const usuarioRef of usuarios) {
    const config = await configDeUid(usuarioRef.id);
    if (config?.clinicaId === clinicaId) {
      (config.fcmTokens || []).forEach((t) => tokens.add(t));
      await agregarTokensDeColaboradoresConSeccion(config, seccion, tokens);
    }
  }
  return [...tokens];
}

// Tokens de TODOS los colaboradores de acceso limitado de una cuenta, sin
// importar qué sección tengan permitida — se usa para el aviso de "cliente
// nuevo", que no es específico de ninguna sección en particular.
async function tokensDeTodosLosColaboradores(config) {
  const tokens = new Set();
  const colaboradores = config?.colaboradoresPermitidos || {};
  for (const uidColaborador of Object.keys(colaboradores)) {
    const configColaborador = await configDeUid(uidColaborador);
    (configColaborador?.fcmTokens || []).forEach((t) => tokens.add(t));
  }
  return [...tokens];
}

async function mandarNotificacion(tokens, dataPayload, etiqueta, nombrePaciente) {
  if (!tokens || tokens.length === 0) {
    console.log(`[${etiqueta}] ${nombrePaciente}: sin dispositivos con notificaciones activadas, se omite.`);
    return false;
  }
  try {
    const resultado = await messaging.sendEachForMulticast({ data: dataPayload, tokens });
    console.log(`[${etiqueta}] Notificación enviada para ${nombrePaciente}: ${resultado.successCount} éxito(s), ${resultado.failureCount} fallo(s).`);
    return true;
  } catch (e) {
    console.error(`[${etiqueta}] Error enviando notificación para ${nombrePaciente}:`, e.message);
    return false;
  }
}

/* ---------------------------------------------------------
   Próximas visitas de pacientes (con hora exacta)
----------------------------------------------------------*/
async function revisarUnPacienteParaVisita(patientDoc, hoy, tokens, etiqueta) {
  const paciente = patientDoc.data();

  if (!paciente.proximaVisitaHora) return false;
  if (paciente.eliminadoEn) return false;

  const marcaDeEstaCita = `${paciente.proximaVisita} ${paciente.proximaVisitaHora}`;
  if (paciente.recordatorioEnviadoPara === marcaDeEstaCita) return false;

  const minutosRestantes = minutosHastaLaCita(paciente.proximaVisita, paciente.proximaVisitaHora);
  if (minutosRestantes < 0 || minutosRestantes > MINUTOS_VENTANA) return false;

  const dataPayload = {
    title: `Cita en ${minutosRestantes <= 1 ? "un momento" : minutosRestantes + " min"}: ${paciente.nombre}`,
    body: paciente.propietario ? `Propietario: ${paciente.propietario}` : "Revisa la ficha del paciente.",
    patientId: String(paciente.id || patientDoc.id),
    foto: paciente.foto || "",
  };

  const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, paciente.nombre);
  await patientDoc.ref.update({ recordatorioEnviadoPara: marcaDeEstaCita });
  return seEnvio;
}

async function revisarVisitasPersonales(hoy) {
  let avisos = 0;
  const usuarios = await db.collection("users").listDocuments();
  console.log(`Revisando ${usuarios.length} cuenta(s) personal(es) — próximas visitas...`);

  for (const usuarioRef of usuarios) {
    const tokens = await tokensDeUsuario(usuarioRef);
    const pacientesSnap = await usuarioRef.collection("patients").where("proximaVisita", "==", hoy).get();
    for (const patientDoc of pacientesSnap.docs) {
      const seEnvio = await revisarUnPacienteParaVisita(patientDoc, hoy, tokens, `users/${usuarioRef.id}`);
      if (seEnvio) avisos++;
    }
  }
  return avisos;
}

async function revisarVisitasDeClinicas(hoy) {
  let avisos = 0;
  const usuarios = await db.collection("users").listDocuments();
  const clinicas = await db.collection("clinics").listDocuments();
  console.log(`Revisando ${clinicas.length} clínica(s) compartida(s) — próximas visitas...`);

  for (const clinicaRef of clinicas) {
    const tokens = await tokensDeClinica(clinicaRef.id, usuarios);
    const pacientesSnap = await clinicaRef.collection("patients").where("proximaVisita", "==", hoy).get();
    for (const patientDoc of pacientesSnap.docs) {
      const seEnvio = await revisarUnPacienteParaVisita(patientDoc, hoy, tokens, `clinics/${clinicaRef.id}`);
      if (seEnvio) avisos++;
    }
  }
  return avisos;
}

/* ---------------------------------------------------------
   Recordatorios por SOLO FECHA (sin hora): vacunas,
   desparasitación, cirugías (próxima revisión) y baños. Se
   avisa una vez el día exacto que corresponde. El nombre de
   "coleccion" es también la clave de sección usada en
   colaboradoresPermitidos (ej. "banos"), así que sirve tanto
   para consultar los documentos como para saber a qué
   colaboradores también avisarles.
----------------------------------------------------------*/
const TIPOS_DE_RECORDATORIO_POR_FECHA = [
  {
    coleccion: "vacunas",
    campoFecha: "proximaDosis",
    construirTitulo: (r) => `Vacuna hoy: ${r.patientName}`,
    construirCuerpo: (r) => `Le corresponde la vacuna: ${r.nombre || "(sin especificar)"}`,
  },
  {
    coleccion: "desparasitaciones",
    campoFecha: "proximaDosis",
    construirTitulo: (r) => `Desparasitación hoy: ${r.patientName}`,
    construirCuerpo: (r) => `Le corresponde desparasitación ${r.tipo ? "(" + r.tipo + ")" : ""}`.trim(),
  },
  {
    coleccion: "cirugias",
    campoFecha: "proximaRevision",
    construirTitulo: (r) => `Revisión post-operatoria hoy: ${r.patientName}`,
    construirCuerpo: (r) => `Seguimiento de: ${r.tipoCirugia || "cirugía"}`,
  },
  {
    coleccion: "banos",
    campoFecha: "proximoBano",
    construirTitulo: (r) => `Baño programado hoy: ${r.patientName}`,
    construirCuerpo: (r) => r.tipo || "Servicio de estética programado",
  },
];

async function revisarRecordatoriosPorFecha(tipoRecordatorio, hoy) {
  const { coleccion, campoFecha, construirTitulo, construirCuerpo } = tipoRecordatorio;
  let avisos = 0;

  const usuarios = await db.collection("users").listDocuments();
  const clinicas = await db.collection("clinics").listDocuments();
  console.log(`Revisando "${coleccion}" (campo ${campoFecha}) en ${usuarios.length} cuenta(s) y ${clinicas.length} clínica(s)...`);

  const procesarColeccion = async (parentRef, tokens, etiqueta) => {
    let contador = 0;
    const snap = await parentRef.collection(coleccion).where(campoFecha, "==", hoy).get();
    for (const doc of snap.docs) {
      const registro = doc.data();
      if (registro.recordatorioEnviadoPara === hoy) continue;

      const dataPayload = {
        title: construirTitulo(registro),
        body: construirCuerpo(registro),
        patientId: String(registro.patientId || ""),
      };
      const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, registro.patientName || "(paciente)");
      await doc.ref.update({ recordatorioEnviadoPara: hoy });
      if (seEnvio) contador++;
    }
    return contador;
  };

  for (const usuarioRef of usuarios) {
    // Tokens del dueño + de cualquier colaborador (ej. un peluquero externo)
    // al que se le haya compartido esta sección específica.
    const tokens = await tokensDeUsuarioConSeccion(usuarioRef, coleccion);
    avisos += await procesarColeccion(usuarioRef, tokens, `users/${usuarioRef.id}`);
  }
  for (const clinicaRef of clinicas) {
    const tokens = await tokensDeClinicaConSeccion(clinicaRef.id, usuarios, coleccion);
    avisos += await procesarColeccion(clinicaRef, tokens, `clinics/${clinicaRef.id}`);
  }

  return avisos;
}

/* ---------------------------------------------------------
   Aviso de "cliente nuevo": cuando la clínica agrega un
   paciente nuevo, se les avisa a sus colaboradores de acceso
   limitado (ej. un peluquero externo) — así se enteran sin
   tener que estar revisando la app. Se usa una ventana de
   tiempo corta (en vez de "solo hoy") porque esto no es una
   cita programada: el aviso debe salir una sola vez, poco
   después de creado el paciente, sin importar la hora exacta
   en que corrió el robot.
----------------------------------------------------------*/
const MINUTOS_VENTANA_CLIENTE_NUEVO = 15;

async function revisarClientesNuevos() {
  let avisos = 0;
  const desde = Date.now() - MINUTOS_VENTANA_CLIENTE_NUEVO * 60 * 1000;
  const usuarios = await db.collection("users").listDocuments();
  const clinicas = await db.collection("clinics").listDocuments();
  console.log(`Revisando clientes nuevos (últimos ${MINUTOS_VENTANA_CLIENTE_NUEVO} min) en ${usuarios.length} cuenta(s) y ${clinicas.length} clínica(s)...`);

  const procesarNuevos = async (parentRef, tokens, etiqueta) => {
    if (!tokens || tokens.length === 0) return 0;
    let contador = 0;
    const snap = await parentRef.collection("patients").where("creadoEn", ">", desde).get();
    for (const doc of snap.docs) {
      const paciente = doc.data();
      if (paciente.eliminadoEn) continue;
      if (paciente.avisoClienteNuevoEnviado) continue;

      const dataPayload = {
        title: `Cliente nuevo: ${paciente.nombre}`,
        body: paciente.propietario ? `Propietario: ${paciente.propietario}` : "Se agregó un nuevo paciente.",
        patientId: String(paciente.id || doc.id),
        foto: paciente.foto || "",
      };
      const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, paciente.nombre);
      await doc.ref.update({ avisoClienteNuevoEnviado: true });
      if (seEnvio) contador++;
    }
    return contador;
  };

  for (const usuarioRef of usuarios) {
    const config = await configDeUid(usuarioRef.id);
    const tokens = await tokensDeTodosLosColaboradores(config);
    avisos += await procesarNuevos(usuarioRef, tokens, `users/${usuarioRef.id}`);
  }
  for (const clinicaRef of clinicas) {
    // Para una clínica en equipo compartido, se avisa a los colaboradores
    // que CUALQUIER miembro del equipo haya agregado.
    const tokens = new Set();
    for (const usuarioRef of usuarios) {
      const config = await configDeUid(usuarioRef.id);
      if (config?.clinicaId === clinicaRef.id) {
        (await tokensDeTodosLosColaboradores(config)).forEach((t) => tokens.add(t));
      }
    }
    avisos += await procesarNuevos(clinicaRef, [...tokens], `clinics/${clinicaRef.id}`);
  }

  return avisos;
}

/* ---------------------------------------------------------
   Avisos hacia la clínica: cuando un colaborador (ej. un
   peluquero) reagenda un baño, lo marca como atendido, o
   elimina un registro de baño de un paciente COMPARTIDO por
   la clínica, la propia app deja un "aviso" pendiente en la
   colección "avisosClinica" de la cuenta dueña. Aquí se
   procesan: se le manda el push SOLO al dueño/equipo (no al
   colaborador que hizo la acción, que ya lo sabe) y se borra
   el aviso ya procesado, para no acumularlos ni repetirlos.
----------------------------------------------------------*/
const TITULOS_AVISO_CLINICA = {
  reagendado: (r) => `Baño reagendado: ${r.patientName}`,
  atendido: (r) => `Baño atendido: ${r.patientName}`,
  eliminado: (r) => `Registro de baño eliminado: ${r.patientName}`,
};

async function revisarAvisosClinica() {
  let avisos = 0;
  const usuarios = await db.collection("users").listDocuments();
  const clinicas = await db.collection("clinics").listDocuments();
  console.log(`Revisando avisos pendientes para la clínica en ${usuarios.length} cuenta(s) y ${clinicas.length} clínica(s)...`);

  const procesarAvisos = async (parentRef, tokens, etiqueta) => {
    let contador = 0;
    const snap = await parentRef.collection("avisosClinica").get();
    for (const doc of snap.docs) {
      const aviso = doc.data();
      const construirTitulo = TITULOS_AVISO_CLINICA[aviso.tipo] || ((r) => `Aviso: ${r.patientName}`);
      const dataPayload = {
        title: construirTitulo(aviso),
        body: aviso.detalle || "",
        patientId: String(aviso.patientId || ""),
      };
      const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, aviso.patientName || "(paciente)");
      // Se borra siempre (haya o no dispositivos con notificaciones activadas)
      // para que la colección no crezca sin límite.
      await doc.ref.delete();
      if (seEnvio) contador++;
    }
    return contador;
  };

  for (const usuarioRef of usuarios) {
    const tokens = await tokensDeUsuario(usuarioRef);
    avisos += await procesarAvisos(usuarioRef, tokens, `users/${usuarioRef.id}`);
  }
  for (const clinicaRef of clinicas) {
    const tokens = await tokensDeClinica(clinicaRef.id, usuarios);
    avisos += await procesarAvisos(clinicaRef, tokens, `clinics/${clinicaRef.id}`);
  }

  return avisos;
}

async function main() {
  const hoy = hoyComoTexto();
  console.log(`Revisando recordatorios para el día ${hoy}...`);

  let totalAvisos = 0;
  totalAvisos += await revisarVisitasPersonales(hoy);
  totalAvisos += await revisarVisitasDeClinicas(hoy);

  for (const tipoRecordatorio of TIPOS_DE_RECORDATORIO_POR_FECHA) {
    totalAvisos += await revisarRecordatoriosPorFecha(tipoRecordatorio, hoy);
  }

  totalAvisos += await revisarClientesNuevos();
  totalAvisos += await revisarAvisosClinica();

  console.log(`Listo. Avisos mandados en esta corrida: ${totalAvisos}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Error general del robot de notificaciones:", e);
    process.exit(1);
  });
