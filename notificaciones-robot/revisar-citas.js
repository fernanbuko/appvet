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

// Igual que hoyComoTexto() pero un día ANTES — para el aviso de "se pasó
// la fecha y no se marcó como atendida", que se manda una sola vez, el día
// siguiente al que correspondía.
function ayerComoTexto() {
  const ahoraEcuador = new Date(Date.now() - 5 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  const y = ahoraEcuador.getUTCFullYear();
  const m = String(ahoraEcuador.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ahoraEcuador.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Igual que hoyComoTexto() pero un día después — para el aviso anticipado
// ("mañana tienes...") que se manda además del aviso del mismo día.
function mananaComoTexto() {
  const ahoraEcuador = new Date(Date.now() - 5 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
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

// Baños/vacunas/desparasitaciones/tratamientos/cirugías guardan solo el
// "patientId" del paciente, no su foto — hay que ir a buscarla a la
// colección "patients" para que la notificación (y la campanita en la app)
// puedan mostrarla. Se cachea por (parentRef + patientId) dentro de la
// misma corrida del robot, para no repetir la misma lectura una y otra vez.
const fotoCache = new Map();
async function fotoDePaciente(parentRef, patientId) {
  if (!patientId) return "";
  const clave = parentRef.path + "/" + patientId;
  if (fotoCache.has(clave)) return fotoCache.get(clave);
  let foto = "";
  try {
    const doc = await parentRef.collection("patients").doc(patientId).get();
    foto = doc.exists ? doc.data()?.foto || "" : "";
  } catch (e) {
    foto = "";
  }
  fotoCache.set(clave, foto);
  return foto;
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

// Dado un grupo de tokens (los que se van a usar para mandar un push),
// busca en la caché de configuraciones ya leídas cuáles cuentas (uids) son
// dueñas de alguno de esos tokens. Se usa para guardar una copia de cada
// notificación en la "bandeja" de cada cuenta destinataria (para el centro
// de notificaciones dentro de la app) sin tener que rehacer todo el
// recorrido de colaboradores en cada función — como para entonces ya se
// leyó la config de cada cuenta involucrada, alcanza con revisar la caché.
function uidsDueñosDeTokens(tokens) {
  const uids = [];
  for (const [uid, config] of configCachePorUid.entries()) {
    if (config?.fcmTokens?.some((t) => tokens.includes(t))) {
      uids.push(uid);
    }
  }
  return uids;
}

async function mandarNotificacion(tokens, dataPayload, etiqueta, nombrePaciente) {
  // Se guarda una copia en la bandeja de cada cuenta destinataria (para el
  // centro de notificaciones dentro de la app), sin importar si el push
  // por FCM en sí se logra entregar al dispositivo o no.
  const uidsDestino = uidsDueñosDeTokens(tokens || []);
  await Promise.all(
    uidsDestino.map((uidDestino) => {
      const ref = db.collection("users").doc(uidDestino).collection("notificaciones").doc();
      return ref
        .set({ ...dataPayload, id: ref.id, leida: false, creadoEn: Date.now() })
        .catch((e) => console.error(`No se pudo guardar la notificación en la bandeja de ${uidDestino}:`, e.message));
    })
  );

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

// Aviso anticipado: un día antes de la cita, sin importar si tiene hora
// puesta o no (a diferencia del aviso de "faltan X minutos", que sí la
// necesita). Se manda una sola vez por cita, aparte del aviso del día.
async function revisarUnaVisitaAnticipada(patientDoc, manana, tokens, etiqueta) {
  const paciente = patientDoc.data();
  if (paciente.eliminadoEn) return false;
  if (paciente.recordatorioAnticipadoEnviadoPara === manana) return false;

  const dataPayload = {
    title: `Cita mañana: ${paciente.nombre}`,
    body: paciente.proximaVisitaHora ? `A las ${paciente.proximaVisitaHora}${paciente.propietario ? " — " + paciente.propietario : ""}` : paciente.propietario ? `Propietario: ${paciente.propietario}` : "Revisa la ficha del paciente.",
    patientId: String(paciente.id || patientDoc.id),
    foto: paciente.foto || "",
  };

  const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, paciente.nombre);
  await patientDoc.ref.update({ recordatorioAnticipadoEnviadoPara: manana });
  return seEnvio;
}

// Aviso de seguimiento: si ya pasó un día de la cita y sigue sin marcarse
// como atendida ni reagendada (es decir, "proximaVisita" sigue siendo la
// misma fecha de ayer — al confirmar o reagendar esos campos se limpian o
// cambian), se pregunta qué pasó. Se manda una sola vez.
async function revisarUnaVisitaVencida(patientDoc, ayer, tokens, etiqueta) {
  const paciente = patientDoc.data();
  if (paciente.eliminadoEn) return false;
  if (paciente.recordatorioVencidoEnviadoPara === ayer) return false;

  const dataPayload = {
    title: `¿Qué pasó con ${paciente.nombre}?`,
    body: `Tenía cita ayer (${ayer}) y sigue sin confirmarse. Revisa su ficha.`,
    patientId: String(paciente.id || patientDoc.id),
    foto: paciente.foto || "",
  };

  const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, paciente.nombre);
  await patientDoc.ref.update({ recordatorioVencidoEnviadoPara: ayer });
  return seEnvio;
}

async function revisarVisitasPersonales(hoy, manana, ayer) {
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
    const pacientesMananaSnap = await usuarioRef.collection("patients").where("proximaVisita", "==", manana).get();
    for (const patientDoc of pacientesMananaSnap.docs) {
      const seEnvio = await revisarUnaVisitaAnticipada(patientDoc, manana, tokens, `users/${usuarioRef.id}`);
      if (seEnvio) avisos++;
    }
    const pacientesAyerSnap = await usuarioRef.collection("patients").where("proximaVisita", "==", ayer).get();
    for (const patientDoc of pacientesAyerSnap.docs) {
      const seEnvio = await revisarUnaVisitaVencida(patientDoc, ayer, tokens, `users/${usuarioRef.id}`);
      if (seEnvio) avisos++;
    }
  }
  return avisos;
}

async function revisarVisitasDeClinicas(hoy, manana, ayer) {
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
    const pacientesMananaSnap = await clinicaRef.collection("patients").where("proximaVisita", "==", manana).get();
    for (const patientDoc of pacientesMananaSnap.docs) {
      const seEnvio = await revisarUnaVisitaAnticipada(patientDoc, manana, tokens, `clinics/${clinicaRef.id}`);
      if (seEnvio) avisos++;
    }
    const pacientesAyerSnap = await clinicaRef.collection("patients").where("proximaVisita", "==", ayer).get();
    for (const patientDoc of pacientesAyerSnap.docs) {
      const seEnvio = await revisarUnaVisitaVencida(patientDoc, ayer, tokens, `clinics/${clinicaRef.id}`);
      if (seEnvio) avisos++;
    }
  }
  return avisos;
}

/* ---------------------------------------------------------
   Recordatorios por SOLO FECHA (sin hora): cirugías (próxima
   revisión) — es la única de las 4 que nunca tiene hora exacta,
   así que se queda con la lógica simple de "una vez el día
   exacto, y otra vez un día antes". El nombre de "coleccion" es
   también la clave de sección usada en colaboradoresPermitidos.

   (vacunas, desparasitaciones, tratamientos y baños ya NO están
   en esta lista: como sí pueden tener hora exacta, se revisan
   con revisarTipoConHora()/TIPOS_CON_HORA, más arriba.)
----------------------------------------------------------*/
const TIPOS_DE_RECORDATORIO_POR_FECHA = [
  {
    coleccion: "cirugias",
    campoFecha: "proximaRevision",
    construirTitulo: (r) => `Revisión post-operatoria hoy: ${r.patientName}`,
    construirTituloManana: (r) => `Revisión post-operatoria mañana: ${r.patientName}`,
    construirTituloVencido: (r) => `¿Qué pasó con ${r.patientName}?`,
    construirCuerpo: (r) => `Seguimiento de: ${r.tipoCirugia || "cirugía"}`,
    construirCuerpoVencido: (r) => `Tenía revisión post-operatoria ayer y no se registró. Revisa su ficha.`,
  },
];

async function revisarRecordatoriosPorFecha(tipoRecordatorio, hoy, manana, ayer) {
  const { coleccion, campoFecha, construirTitulo, construirTituloManana, construirTituloVencido, construirCuerpo, construirCuerpoVencido } = tipoRecordatorio;
  let avisos = 0;

  const usuarios = await db.collection("users").listDocuments();
  const clinicas = await db.collection("clinics").listDocuments();
  console.log(`Revisando "${coleccion}" (campo ${campoFecha}) en ${usuarios.length} cuenta(s) y ${clinicas.length} clínica(s)...`);

  const procesarColeccion = async (parentRef, tokens, etiqueta) => {
    let contador = 0;

    // Aviso del mismo día
    const snapHoy = await parentRef.collection(coleccion).where(campoFecha, "==", hoy).get();
    for (const doc of snapHoy.docs) {
      const registro = doc.data();
      if (registro.recordatorioEnviadoPara === hoy) continue;

      const dataPayload = {
        title: construirTitulo(registro),
        body: construirCuerpo(registro),
        patientId: String(registro.patientId || ""),
        foto: await fotoDePaciente(parentRef, registro.patientId),
      };
      const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, registro.patientName || "(paciente)");
      await doc.ref.update({ recordatorioEnviadoPara: hoy });
      if (seEnvio) contador++;
    }

    // Aviso "un día antes" (marca aparte, para no chocar con el del mismo día)
    const snapManana = await parentRef.collection(coleccion).where(campoFecha, "==", manana).get();
    for (const doc of snapManana.docs) {
      const registro = doc.data();
      if (registro.recordatorioAnticipadoEnviadoPara === manana) continue;

      const dataPayload = {
        title: construirTituloManana(registro),
        body: construirCuerpo(registro),
        patientId: String(registro.patientId || ""),
        foto: await fotoDePaciente(parentRef, registro.patientId),
      };
      const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, registro.patientName || "(paciente)");
      await doc.ref.update({ recordatorioAnticipadoEnviadoPara: manana });
      if (seEnvio) contador++;
    }

    // Aviso "se pasó la fecha" (un día después, una sola vez, preguntando
    // qué pasó — el registro sigue con la misma fecha porque nadie lo
    // actualizó ni registró uno nuevo)
    const snapAyer = await parentRef.collection(coleccion).where(campoFecha, "==", ayer).get();
    for (const doc of snapAyer.docs) {
      const registro = doc.data();
      if (registro.recordatorioVencidoEnviadoPara === ayer) continue;

      const dataPayload = {
        title: construirTituloVencido(registro),
        body: construirCuerpoVencido(registro),
        patientId: String(registro.patientId || ""),
        foto: await fotoDePaciente(parentRef, registro.patientId),
      };
      const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, registro.patientName || "(paciente)");
      await doc.ref.update({ recordatorioVencidoEnviadoPara: ayer });
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
   Recordatorios CON HORA opcional: baños, vacunas,
   desparasitación y tratamientos inyectables pueden tener una
   fecha futura CON o SIN hora exacta puesta. Esta única función
   generaliza lo que antes solo hacía revisarUnBano():
     - Si tiene hora: avisa cuando falten 30 min o menos.
     - Si no tiene hora: avisa una sola vez, el mismo día.
     - En los dos casos, además avisa un día antes.
     - Y si se pasó un día completo sin que nadie lo tocara
       (misma fecha que ayer), pregunta "¿qué pasó?".
   ("cirugias" no está aquí porque su "próxima revisión" nunca
   tiene hora — sigue en TIPOS_DE_RECORDATORIO_POR_FECHA, más
   abajo.)
----------------------------------------------------------*/
const TIPOS_CON_HORA = [
  {
    coleccion: "banos",
    campoFecha: "proximoBano",
    campoHora: "proximoBanoHora",
    tituloHoyConHora: (r, min) => `Baño en ${min <= 1 ? "un momento" : min + " min"}: ${r.patientName}`,
    tituloHoySinHora: (r) => `Baño programado hoy: ${r.patientName}`,
    tituloManana: (r) => `Baño mañana: ${r.patientName}`,
    tituloVencido: (r) => `¿Qué pasó con ${r.patientName}?`,
    cuerpoHoy: (r) => r.tipo || "Servicio de estética programado",
    cuerpoManana: (r) => `${r.tipo || "Servicio de estética programado"}${r.proximoBanoHora ? " — " + r.proximoBanoHora : ""}`,
    cuerpoVencido: (r) => `Tenía baño ayer (${r.tipo || "servicio de estética"}) y sigue sin marcarse como atendido.`,
  },
  {
    coleccion: "vacunas",
    campoFecha: "proximaDosis",
    campoHora: "proximaDosisHora",
    tituloHoyConHora: (r, min) => `Vacuna en ${min <= 1 ? "un momento" : min + " min"}: ${r.patientName}`,
    tituloHoySinHora: (r) => `Vacuna hoy: ${r.patientName}`,
    tituloManana: (r) => `Vacuna mañana: ${r.patientName}`,
    tituloVencido: (r) => `¿Qué pasó con ${r.patientName}?`,
    cuerpoHoy: (r) => `Le corresponde la vacuna: ${r.nombre || "(sin especificar)"}`,
    cuerpoManana: (r) => `Le corresponde la vacuna: ${r.nombre || "(sin especificar)"}${r.proximaDosisHora ? " — " + r.proximaDosisHora : ""}`,
    cuerpoVencido: (r) => `Tenía vacuna ayer (${r.nombre || "sin especificar"}) y no se registró. Revisa su ficha.`,
  },
  {
    coleccion: "desparasitaciones",
    campoFecha: "proximaDosis",
    campoHora: "proximaDosisHora",
    tituloHoyConHora: (r, min) => `Desparasitación en ${min <= 1 ? "un momento" : min + " min"}: ${r.patientName}`,
    tituloHoySinHora: (r) => `Desparasitación hoy: ${r.patientName}`,
    tituloManana: (r) => `Desparasitación mañana: ${r.patientName}`,
    tituloVencido: (r) => `¿Qué pasó con ${r.patientName}?`,
    cuerpoHoy: (r) => `Le corresponde desparasitación ${r.tipo ? "(" + r.tipo + ")" : ""}`.trim(),
    cuerpoManana: (r) => `Le corresponde desparasitación ${r.tipo ? "(" + r.tipo + ")" : ""}`.trim() + (r.proximaDosisHora ? ` — ${r.proximaDosisHora}` : ""),
    cuerpoVencido: (r) => `Tenía desparasitación ayer y no se registró. Revisa su ficha.`,
  },
  {
    coleccion: "tratamientos",
    campoFecha: "proximaAplicacion",
    campoHora: "proximaAplicacionHora",
    tituloHoyConHora: (r, min) => `Tratamiento en ${min <= 1 ? "un momento" : min + " min"}: ${r.patientName}`,
    tituloHoySinHora: (r) => `Tratamiento inyectable hoy: ${r.patientName}`,
    tituloManana: (r) => `Tratamiento inyectable mañana: ${r.patientName}`,
    tituloVencido: (r) => `¿Qué pasó con ${r.patientName}?`,
    cuerpoHoy: (r) => r.descripcion || "Tratamiento inyectable programado",
    cuerpoManana: (r) => `${r.descripcion || "Tratamiento inyectable programado"}${r.proximaAplicacionHora ? " — " + r.proximaAplicacionHora : ""}`,
    cuerpoVencido: (r) => `Tenía tratamiento inyectable programado ayer (${r.descripcion || "sin especificar"}) y no se registró. Revisa su ficha.`,
  },
];

async function revisarUnoConHora(tipo, doc, hoy, manana, ayer, tokens, etiqueta, foto) {
  const { campoFecha, campoHora, tituloHoyConHora, tituloHoySinHora, tituloManana, tituloVencido, cuerpoHoy, cuerpoManana, cuerpoVencido } = tipo;
  const r = doc.data();
  if (!r[campoFecha]) return 0;
  let contador = 0;

  if (r[campoFecha] === hoy) {
    if (campoHora && r[campoHora]) {
      const marcaDeEstaCita = `${r[campoFecha]} ${r[campoHora]}`;
      if (r.recordatorioEnviadoPara !== marcaDeEstaCita) {
        const minutosRestantes = minutosHastaLaCita(r[campoFecha], r[campoHora]);
        if (minutosRestantes >= 0 && minutosRestantes <= MINUTOS_VENTANA) {
          const dataPayload = {
            title: tituloHoyConHora(r, minutosRestantes),
            body: cuerpoHoy(r),
            patientId: String(r.patientId || ""),
            foto: foto || "",
          };
          const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, r.patientName || "(paciente)");
          await doc.ref.update({ recordatorioEnviadoPara: marcaDeEstaCita });
          if (seEnvio) contador++;
        }
      }
    } else if (r.recordatorioEnviadoPara !== hoy) {
      const dataPayload = {
        title: tituloHoySinHora(r),
        body: cuerpoHoy(r),
        patientId: String(r.patientId || ""),
        foto: foto || "",
      };
      const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, r.patientName || "(paciente)");
      await doc.ref.update({ recordatorioEnviadoPara: hoy });
      if (seEnvio) contador++;
    }
  }

  if (r[campoFecha] === manana && r.recordatorioAnticipadoEnviadoPara !== manana) {
    const dataPayload = {
      title: tituloManana(r),
      body: cuerpoManana(r),
      patientId: String(r.patientId || ""),
      foto: foto || "",
    };
    const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, r.patientName || "(paciente)");
    await doc.ref.update({ recordatorioAnticipadoEnviadoPara: manana });
    if (seEnvio) contador++;
  }

  // "Se pasó la fecha" — si sigue con la misma fecha de ayer, es porque
  // nadie lo tocó (registrar uno nuevo o editar este limpia/cambia el campo).
  if (r[campoFecha] === ayer && r.recordatorioVencidoEnviadoPara !== ayer) {
    const dataPayload = {
      title: tituloVencido(r),
      body: cuerpoVencido(r),
      patientId: String(r.patientId || ""),
      foto: foto || "",
    };
    const seEnvio = await mandarNotificacion(tokens, dataPayload, etiqueta, r.patientName || "(paciente)");
    await doc.ref.update({ recordatorioVencidoEnviadoPara: ayer });
    if (seEnvio) contador++;
  }

  return contador;
}

async function revisarTipoConHora(tipo, hoy, manana, ayer) {
  const { coleccion, campoFecha } = tipo;
  let avisos = 0;
  const usuarios = await db.collection("users").listDocuments();
  const clinicas = await db.collection("clinics").listDocuments();
  console.log(`Revisando "${coleccion}" (con hora, ayer/hoy/mañana) en ${usuarios.length} cuenta(s) y ${clinicas.length} clínica(s)...`);

  const procesarColeccion = async (parentRef, tokens, etiqueta) => {
    let contador = 0;
    const snapHoy = await parentRef.collection(coleccion).where(campoFecha, "==", hoy).get();
    const snapManana = await parentRef.collection(coleccion).where(campoFecha, "==", manana).get();
    const snapAyer = await parentRef.collection(coleccion).where(campoFecha, "==", ayer).get();
    const vistos = new Set();
    for (const doc of [...snapHoy.docs, ...snapManana.docs, ...snapAyer.docs]) {
      if (vistos.has(doc.id)) continue;
      vistos.add(doc.id);
      const foto = await fotoDePaciente(parentRef, doc.data().patientId);
      contador += await revisarUnoConHora(tipo, doc, hoy, manana, ayer, tokens, etiqueta, foto);
    }
    return contador;
  };

  for (const usuarioRef of usuarios) {
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
        foto: await fotoDePaciente(parentRef, aviso.patientId),
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

/* ---------------------------------------------------------
   Dirección contraria: cuando la propia clínica programa o
   reagenda un baño, se les avisa AL INSTANTE a sus
   colaboradores con acceso a "Baños" (ej. un peluquero
   externo) — sin esperar al aviso del mismo día que ya manda
   revisarRecordatoriosPorFecha. La app deja el evento en
   "avisosColaboradores" de la propia cuenta del dueño (no
   necesita ninguna regla nueva de Firestore, ya que el dueño
   siempre tiene acceso total a lo suyo); aquí se procesa: se
   le manda el push a los colaboradores (no al dueño, que ya
   lo sabe) y se borra el evento ya procesado.
----------------------------------------------------------*/
const TITULOS_AVISO_COLABORADORES = {
  programado: (r) => `Nuevo baño programado: ${r.patientName}`,
  reagendado: (r) => `Baño reagendado: ${r.patientName}`,
};

async function revisarAvisosColaboradores() {
  let avisos = 0;
  const usuarios = await db.collection("users").listDocuments();
  console.log(`Revisando avisos pendientes para colaboradores en ${usuarios.length} cuenta(s)...`);

  for (const usuarioRef of usuarios) {
    const snap = await usuarioRef.collection("avisosColaboradores").get();
    if (snap.empty) continue;

    const config = await configDeUid(usuarioRef.id);
    const tokens = new Set();
    await agregarTokensDeColaboradoresConSeccion(config, "banos", tokens);
    const tokensArr = [...tokens];

    for (const doc of snap.docs) {
      const aviso = doc.data();
      const construirTitulo = TITULOS_AVISO_COLABORADORES[aviso.tipo] || ((r) => `Aviso: ${r.patientName}`);
      const dataPayload = {
        title: construirTitulo(aviso),
        body: aviso.detalle || "",
        patientId: String(aviso.patientId || ""),
        foto: await fotoDePaciente(usuarioRef, aviso.patientId),
      };
      const seEnvio = await mandarNotificacion(tokensArr, dataPayload, `users/${usuarioRef.id}`, aviso.patientName || "(paciente)");
      await doc.ref.delete();
      if (seEnvio) avisos++;
    }
  }

  return avisos;
}

/* ---------------------------------------------------------
   Panel del propietario de la app: arma un resumen de TODAS las
   cuentas registradas (no reglas de seguridad nuevas — el robot
   ya tiene acceso total como administrador) y lo guarda DENTRO
   de la propia cuenta del propietario, en
   users/{OWNER_UID}/data/panelPropietario — el mismo lugar y
   formato ({value: ...}) que usa store.set() en la app, así la
   app solo necesita leer sus propios datos para mostrarlo, sin
   tocar las reglas de Firestore.

   De paso, compara la lista de cuentas contra la de la corrida
   anterior (guardada en ese mismo resumen) para detectar cuentas
   RECIÉN registradas y avisarle al propietario por notificación.
----------------------------------------------------------*/
const OWNER_UID = "nmV0gBjVkHePN02d0OYomH8ilqI3";

/* ---------------------------------------------------------
   Procesa solicitudes de "eliminar una cuenta ajena por
   completo" (pacientes, historial, TODO + su acceso de inicio
   de sesión) — dejadas desde el Panel de la app en
   users/{OWNER_UID}/data/solicitudesEliminacionCuenta. Como el
   robot corre con permisos de administrador, sí puede borrar
   los datos de cualquier cuenta; la app nunca tiene ese permiso
   directamente (por eso pasa por aquí en vez de borrar de una).
----------------------------------------------------------*/
async function procesarSolicitudesEliminacion() {
  try {
    const ownerDataRef = db.collection("users").doc(OWNER_UID).collection("data");
    const doc = await ownerDataRef.doc("solicitudesEliminacionCuenta").get();
    const solicitudes = doc.exists ? doc.data()?.value || [] : [];
    if (solicitudes.length === 0) return;

    const pendientes = [];
    for (const solicitud of solicitudes) {
      const { uid, clinica } = solicitud || {};
      if (!uid || uid === OWNER_UID) continue; // nunca te borres a ti mismo por accidente
      try {
        // El correo hay que sacarlo ANTES de borrar — una vez eliminada
        // la cuenta de Authentication, ya no hay forma de recuperarlo.
        let correo = "";
        try {
          const authUser = await admin.auth().getUser(uid);
          correo = authUser.email || "";
        } catch (e) {
          correo = "";
        }
        // Borra TODOS los datos de esa cuenta (todas sus subcolecciones:
        // patients, recetas, examenes, historial, vacunas, banos, etc.)
        await db.recursiveDelete(db.collection("users").doc(uid));
        // Borra también su acceso de inicio de sesión (Firebase Auth).
        try {
          await admin.auth().deleteUser(uid);
        } catch (e) {
          console.log(`  (no se pudo borrar de Authentication — puede que ya no existiera): ${e.message}`);
        }
        // Deja registrado el correo (nada más) para que, si esa persona
        // vuelve a intentar entrar, la app le avise "tu cuenta fue
        // eliminada" en vez de dejarla pasar como si fuera nueva.
        if (correo) {
          const registroRef = db.collection("sistema").doc("cuentasEliminadas");
          const registroDoc = await registroRef.get();
          const correosActuales = registroDoc.exists ? registroDoc.data()?.correos || [] : [];
          if (!correosActuales.includes(correo)) {
            await registroRef.set({
              correos: [...correosActuales, correo]
            });
          }
        }
        console.log(`🗑️ Cuenta eliminada por completo: ${clinica || "(sin nombre)"} (${uid})`);
      } catch (e) {
        console.error(`No se pudo eliminar la cuenta ${uid}:`, e.message);
        pendientes.push(solicitud); // se reintenta en la próxima corrida
      }
    }
    await ownerDataRef.doc("solicitudesEliminacionCuenta").set({
      value: pendientes
    });
  } catch (e) {
    console.error("Error procesando solicitudes de eliminación:", e.message);
  }
}

/* ---------------------------------------------------------
   Procesa solicitudes de "bloquear/desbloquear el acceso" de
   una cuenta ajena — a diferencia de eliminar, esto NO borra
   ningún dato: solo activa/desactiva su cuenta en Firebase
   Authentication (auth().updateUser(uid, {disabled})), así que
   se puede revertir en cualquier momento. Se guarda la
   solicitud en users/{OWNER_UID}/data/solicitudesBloqueo, igual
   patrón que las eliminaciones.
----------------------------------------------------------*/
async function procesarSolicitudesBloqueo() {
  try {
    const ownerDataRef = db.collection("users").doc(OWNER_UID).collection("data");
    const doc = await ownerDataRef.doc("solicitudesBloqueo").get();
    const solicitudes = doc.exists ? doc.data()?.value || [] : [];
    if (solicitudes.length === 0) return;

    const pendientes = [];
    for (const solicitud of solicitudes) {
      const { uid, bloquear, clinica } = solicitud || {};
      if (!uid || uid === OWNER_UID) continue; // nunca te bloquees a ti mismo por accidente
      try {
        await admin.auth().updateUser(uid, {
          disabled: !!bloquear
        });
        console.log(`${bloquear ? "🔒 Bloqueada" : "🔓 Desbloqueada"} la cuenta: ${clinica || "(sin nombre)"} (${uid})`);
      } catch (e) {
        console.error(`No se pudo ${bloquear ? "bloquear" : "desbloquear"} la cuenta ${uid}:`, e.message);
        pendientes.push(solicitud); // se reintenta en la próxima corrida
      }
    }
    await ownerDataRef.doc("solicitudesBloqueo").set({
      value: pendientes
    });
  } catch (e) {
    console.error("Error procesando solicitudes de bloqueo:", e.message);
  }
}

async function actualizarPanelPropietario() {
  try {
    const usuarios = await db.collection("users").listDocuments();
    const cuentas = [];
    let totalPacientes = 0;
    let totalColaboradores = 0;

    for (const usuarioRef of usuarios) {
      if (usuarioRef.id === OWNER_UID) continue; // tu propia cuenta no cuenta — es de prueba/soporte, no una clínica real
      const config = await configDeUid(usuarioRef.id);
      if (!config) continue; // cuenta a medio registrar (sin config todavía)
      let numPacientes = 0;
      try {
        const patientsSnap = await usuarioRef.collection("patients").get();
        numPacientes = patientsSnap.size;
      } catch (e) {
        numPacientes = 0;
      }
      // El correo NO se guarda en Firestore (solo vive en Firebase
      // Authentication) — por eso hay que pedirlo aparte con el SDK de
      // administrador. Si la cuenta se borró de Authentication pero le
      // quedaron datos sueltos en Firestore, esto simplemente no encuentra
      // nada y se deja en blanco, sin romper el resto del panel.
      let correo = "";
      let bloqueado = false;
      let fechaCreacionAuth = null;
      try {
        const authUser = await admin.auth().getUser(usuarioRef.id);
        correo = authUser.email || "";
        bloqueado = !!authUser.disabled;
        // Respaldo para cuentas creadas ANTES de que existiera el campo
        // "fechaRegistro" en la configuración (se agregó después, así que
        // esas cuentas viejas nunca lo llegaron a guardar) — Firebase
        // Authentication sí sabe, de forma confiable, cuándo se creó
        // realmente cada cuenta, sin depender de ningún campo nuestro.
        fechaCreacionAuth = authUser.metadata?.creationTime ? new Date(authUser.metadata.creationTime).getTime() : null;
      } catch (e) {
        correo = "";
      }
      // "Última conexión": la deja guardada la propia app (index.html) cada
      // vez que alguien la abre, en un documento aparte y liviano. Si por
      // algún motivo no existe (cuenta muy vieja, de antes de este cambio),
      // simplemente se deja en null y el panel muestra "No disponible".
      let ultimaConexion = null;
      try {
        const ultimaConexionDoc = await usuarioRef.collection("data").doc("ultimaConexion").get();
        ultimaConexion = ultimaConexionDoc.exists ? ultimaConexionDoc.data()?.value || null : null;
      } catch (e) {
        ultimaConexion = null;
      }
      const numColaboradores = config.colaboradoresPermitidos ? Object.keys(config.colaboradoresPermitidos).length : 0;
      totalPacientes += numPacientes;
      totalColaboradores += numColaboradores;
      cuentas.push({
        uid: usuarioRef.id,
        correo,
        bloqueado,
        clinica: config.clinica || "(sin nombre)",
        logo: config.logo || "",
        doctorNombres: config.doctorNombres || "",
        rol: config.rol || "veterinario",
        fechaRegistro: config.fechaRegistro || fechaCreacionAuth,
        ultimaConexion,
        pacientes: numPacientes,
        colaboradores: numColaboradores
      });
    }

    cuentas.sort((a, b) => (b.fechaRegistro || 0) - (a.fechaRegistro || 0));

    // Comparar contra la corrida anterior para detectar cuentas nuevas.
    const ownerDataRef = db.collection("users").doc(OWNER_UID).collection("data");
    const panelAnteriorDoc = await ownerDataRef.doc("panelPropietario").get();
    const panelAnterior = panelAnteriorDoc.exists ? panelAnteriorDoc.data()?.value : null;
    const uidsConocidos = new Set((panelAnterior?.cuentas || []).map(c => c.uid));
    const cuentasNuevas = panelAnterior ? cuentas.filter(c => !uidsConocidos.has(c.uid)) : []; // primera corrida: no avisar de "todas" de golpe

    const resumen = {
      actualizadoEn: Date.now(),
      totalClinicas: cuentas.length,
      totalPacientes,
      totalColaboradores,
      cuentas
    };
    await ownerDataRef.doc("panelPropietario").set({
      value: resumen
    });
    console.log(`Panel de propietario actualizado: ${cuentas.length} cuenta(s), ${totalPacientes} paciente(s) en total.`);

    if (cuentasNuevas.length > 0) {
      const tokens = await tokensDeUsuario({
        id: OWNER_UID
      });
      for (const cuenta of cuentasNuevas) {
        const dataPayload = {
          title: "🆕 Nueva cuenta registrada",
          body: `${cuenta.clinica} (${cuenta.doctorNombres || "sin nombre"}) se acaba de registrar.`,
          patientId: ""
        };
        await mandarNotificacion(tokens, dataPayload, `users/${OWNER_UID}`, cuenta.clinica);
      }
    }
  } catch (e) {
    console.error("No se pudo actualizar el panel de propietario:", e.message);
  }
}

async function main() {
  const hoy = hoyComoTexto();
  const manana = mananaComoTexto();
  const ayer = ayerComoTexto();
  console.log(`Revisando recordatorios para el día ${hoy} (anticipado: ${manana}, vencidos: ${ayer})...`);

  let totalAvisos = 0;
  totalAvisos += await revisarVisitasPersonales(hoy, manana, ayer);
  totalAvisos += await revisarVisitasDeClinicas(hoy, manana, ayer);

  for (const tipoRecordatorio of TIPOS_DE_RECORDATORIO_POR_FECHA) {
    totalAvisos += await revisarRecordatoriosPorFecha(tipoRecordatorio, hoy, manana, ayer);
  }

  for (const tipo of TIPOS_CON_HORA) {
    totalAvisos += await revisarTipoConHora(tipo, hoy, manana, ayer);
  }

  totalAvisos += await revisarClientesNuevos();
  totalAvisos += await revisarAvisosClinica();
  totalAvisos += await revisarAvisosColaboradores();

  await procesarSolicitudesEliminacion();
  await procesarSolicitudesBloqueo();
  await actualizarPanelPropietario();

  console.log(`Listo. Avisos mandados en esta corrida: ${totalAvisos}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Error general del robot de notificaciones:", e);
    process.exit(1);
  });
