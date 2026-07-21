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

async function tokensDeUsuario(usuarioRef) {
  const configDoc = await usuarioRef.collection("data").doc("config").get();
  return configDoc.exists ? configDoc.data()?.value?.fcmTokens || [] : [];
}

async function tokensDeClinica(clinicaId, usuarios) {
  const tokens = [];
  for (const usuarioRef of usuarios) {
    const configDoc = await usuarioRef.collection("data").doc("config").get();
    const valor = configDoc.exists ? configDoc.data()?.value : null;
    if (valor?.clinicaId === clinicaId && Array.isArray(valor.fcmTokens)) {
      tokens.push(...valor.fcmTokens);
    }
  }
  return [...new Set(tokens)];
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
   avisa una vez el día exacto que corresponde.
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
    const tokens = await tokensDeUsuario(usuarioRef);
    avisos += await procesarColeccion(usuarioRef, tokens, `users/${usuarioRef.id}`);
  }
  for (const clinicaRef of clinicas) {
    const tokens = await tokensDeClinica(clinicaRef.id, usuarios);
    avisos += await procesarColeccion(clinicaRef, tokens, `clinics/${clinicaRef.id}`);
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

  console.log(`Listo. Avisos mandados en esta corrida: ${totalAvisos}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Error general del robot de notificaciones:", e);
    process.exit(1);
  });
